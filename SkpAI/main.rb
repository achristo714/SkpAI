# frozen_string_literal: true
#
# SkpAI implementation. Keeps Ruby thin: it owns the menu, the HtmlDialog,
# viewport capture, and writing generated files to disk. Everything that
# talks to fal.ai (rendering, video, prompt enhancing) lives in the JS app
# running inside the dialog's embedded Chromium (CEF), reached over the
# add_action_callback / execute_script bridge.

require 'sketchup.rb'
require 'base64'
require 'json'
require 'fileutils'
require 'tmpdir'

module SkpAI
  HTML_DIR   = File.join(File.dirname(__FILE__), 'html')
  # Long edge (px) the captured viewport is scaled to before it is sent to
  # fal. Keeps the base64 payload and render cost sane while staying crisp.
  CAPTURE_LONG_EDGE = 1536

  class << self
    attr_accessor :dialog

    def show_dialog
      unless defined?(UI::HtmlDialog)
        UI.messagebox("SkpAI needs SketchUp 2017 or newer (HtmlDialog).")
        return
      end

      if @dialog && @dialog.visible?
        @dialog.bring_to_front
        return
      end

      @dialog = UI::HtmlDialog.new(
        dialog_title:    'SkpAI',
        preferences_key: 'com.skpai.airender',
        scrollable:      true,
        resizable:       true,
        width:           420,
        height:          860,
        min_width:       380,
        min_height:      560,
        style:           UI::HtmlDialog::STYLE_DIALOG
      )
      @dialog.set_file(File.join(HTML_DIR, 'dialog.html'))
      attach_callbacks(@dialog)
      @dialog.show
    end

    def attach_callbacks(dialog)
      # JS -> Ruby: grab the current viewport, hand back a PNG data URI.
      dialog.add_action_callback('capture_viewport') do |_ctx|
        data_uri = capture_viewport
        if data_uri
          push(dialog, "SkpAI.onViewport(#{data_uri.to_json})")
        else
          push(dialog, "SkpAI.onError('No active model / viewport to capture.')")
        end
      end

      # JS -> Ruby: save a base64 payload (a render still) to disk.
      dialog.add_action_callback('save_data_url') do |_ctx, filename, data_url|
        path = save_data_url(filename, data_url)
        push(dialog, "SkpAI.onSaved(#{(path || '').to_json})") if path
      end

      # JS -> Ruby: open a remote URL (e.g. the finished video) in the browser.
      dialog.add_action_callback('open_url') do |_ctx, url|
        UI.openURL(url) if url && !url.empty?
      end

      # JS -> Ruby: persist the last-used API key etc. into SketchUp defaults
      # so it survives restarts even if localStorage is cleared.
      dialog.add_action_callback('store_pref') do |_ctx, key, value|
        Sketchup.write_default('SkpAI', key.to_s, value.to_s)
      end
      dialog.add_action_callback('read_pref') do |_ctx, key|
        val = Sketchup.read_default('SkpAI', key.to_s, '')
        push(dialog, "SkpAI.onPref(#{key.to_json}, #{val.to_json})")
      end

      # --- batch: render every scene (SketchUp "page") ------------------
      # JS -> Ruby: report the model's scenes so JS can drive the batch.
      dialog.add_action_callback('list_scenes') do |_ctx|
        scenes = scene_list
        push(dialog, "SkpAI.onScenes(#{scenes.to_json})")
      end

      # JS -> Ruby: snapshot view state and turn scene transitions off so
      # each scene can be applied and captured instantly.
      dialog.add_action_callback('batch_begin') do |_ctx|
        batch_begin
        push(dialog, 'SkpAI.onBatchReady()')
      end

      # JS -> Ruby: apply scene <index>, capture it, hand back the image.
      dialog.add_action_callback('capture_scene') do |_ctx, index|
        name, data_uri = capture_scene(index.to_i)
        if data_uri
          push(dialog, "SkpAI.onSceneCapture(#{index.to_i}, #{name.to_json}, #{data_uri.to_json})")
        else
          push(dialog, "SkpAI.onSceneCapture(#{index.to_i}, #{name.to_json}, null)")
        end
      end

      # JS -> Ruby: restore the view state saved in batch_begin.
      dialog.add_action_callback('batch_end') do |_ctx|
        batch_end
      end

      # --- export history (persists across close / reopen / restart) ----
      # JS -> Ruby: hand back the whole saved history index.
      dialog.add_action_callback('history_load') do |_ctx|
        push(dialog, "SkpAI.onHistory(#{history_index.to_json})")
      end

      # JS -> Ruby: persist an entry (+ full-res PNG data URI) to disk.
      dialog.add_action_callback('history_add') do |_ctx, meta_json, data_url|
        entry = history_add(meta_json, data_url)
        push(dialog, "SkpAI.onHistoryAdded(#{entry.to_json})") if entry
      end

      # JS -> Ruby: read one entry's full-res PNG back as a data URI.
      dialog.add_action_callback('history_get_full') do |_ctx, id|
        d = history_full(id)
        push(dialog, "SkpAI.onHistoryFull(#{id.to_json}, #{(d || '').to_json})")
      end

      # JS -> Ruby: delete one entry (index + media), return refreshed index.
      dialog.add_action_callback('history_delete') do |_ctx, id|
        history_delete(id)
        push(dialog, "SkpAI.onHistory(#{history_index.to_json})")
      end

      # JS -> Ruby: wipe the whole history.
      dialog.add_action_callback('history_clear') do |_ctx|
        history_clear
        push(dialog, "SkpAI.onHistory(#{history_index.to_json})")
      end

      # JS -> Ruby: export one stored render to a user-chosen file.
      dialog.add_action_callback('history_export') do |_ctx, id|
        path = history_export(id)
        push(dialog, "SkpAI.onSaved(#{(path || '').to_json})") if path
      end
    end

    # Renders the active view to a temp PNG, scaled to CAPTURE_LONG_EDGE on
    # its long edge, and returns it as a data: URI. nil if nothing is open.
    def capture_viewport
      model = Sketchup.active_model
      return nil unless model

      render_view_to_data_uri(model.active_view)
    end

    # Shared capture: write the given view to a temp PNG scaled to
    # CAPTURE_LONG_EDGE on its long edge, return a data: URI (or nil).
    def render_view_to_data_uri(view)
      return nil unless view

      vw = view.vpwidth.to_f
      vh = view.vpheight.to_f
      return nil if vw <= 0 || vh <= 0

      scale = CAPTURE_LONG_EDGE / [vw, vh].max
      scale = 1.0 if scale > 1.0 # never upscale
      w = (vw * scale).round
      h = (vh * scale).round

      tmp = File.join(temp_dir, "skpai_capture_#{Time.now.to_i}_#{rand(9999)}.png")
      ok = view.write_image(
        filename:    tmp,
        width:       w,
        height:      h,
        antialias:   true,
        transparent: false
      )
      return nil unless ok && File.exist?(tmp)

      b64 = Base64.strict_encode64(File.binread(tmp))
      File.delete(tmp) rescue nil
      "data:image/png;base64,#{b64}"
    rescue StandardError => e
      warn("SkpAI capture error: #{e.message}")
      nil
    end

    # --- scenes / batch -------------------------------------------------

    # [{index:, name:}, ...] for every scene (page) in the active model.
    def scene_list
      model = Sketchup.active_model
      return [] unless model

      model.pages.to_a.each_with_index.map do |page, i|
        { index: i, name: (page.name && !page.name.empty? ? page.name : "Scene #{i + 1}") }
      end
    rescue StandardError
      []
    end

    # Save view state and disable scene transitions so each page can be
    # applied and captured instantly (no mid-animation frames).
    def batch_begin
      model = Sketchup.active_model
      return unless model

      opts = model.options['PageOptions']
      @batch_state = {
        page:       model.pages.selected_page,
        show_trans: (opts ? opts['ShowTransition'] : nil),
        trans_time: (opts ? opts['TransitionTime'] : nil),
      }
      if opts
        opts['ShowTransition'] = false
        opts['TransitionTime'] = 0.0
      end
    rescue StandardError => e
      warn("SkpAI batch_begin: #{e.message}")
    end

    # Apply scene <index>, capture it. Returns [name, data_uri|nil].
    def capture_scene(index)
      model = Sketchup.active_model
      return [nil, nil] unless model

      page = model.pages[index]
      return ["Scene #{index + 1}", nil] unless page

      model.pages.selected_page = page
      name = page.name && !page.name.empty? ? page.name : "Scene #{index + 1}"
      [name, render_view_to_data_uri(model.active_view)]
    rescue StandardError => e
      warn("SkpAI capture_scene: #{e.message}")
      ["Scene #{index + 1}", nil]
    end

    # Restore the view state captured in batch_begin.
    def batch_end
      model = Sketchup.active_model
      return unless model && @batch_state

      opts = model.options['PageOptions']
      if opts
        opts['ShowTransition'] = @batch_state[:show_trans] unless @batch_state[:show_trans].nil?
        opts['TransitionTime'] = @batch_state[:trans_time] unless @batch_state[:trans_time].nil?
      end
      model.pages.selected_page = @batch_state[:page] if @batch_state[:page]
      @batch_state = nil
    rescue StandardError => e
      warn("SkpAI batch_end: #{e.message}")
    end

    # --- export history -------------------------------------------------
    # Persisted under ~/.skpai so renders survive closing/reopening the
    # extension and restarting SketchUp. index.json holds lightweight
    # entries (prompt, aesthetic, scene, timestamp, small thumb); the
    # full-res PNGs live in ~/.skpai/media/<id>.png.
    HISTORY_ROOT = File.join(Dir.home, '.skpai')
    HISTORY_MAX  = 80

    def history_dir
      FileUtils.mkdir_p(HISTORY_ROOT)
      HISTORY_ROOT
    end

    def history_media_dir
      d = File.join(HISTORY_ROOT, 'media')
      FileUtils.mkdir_p(d)
      d
    end

    def history_index_path
      File.join(history_dir, 'index.json')
    end

    def history_index
      return [] unless File.exist?(history_index_path)
      data = JSON.parse(File.read(history_index_path))
      data.is_a?(Array) ? data : []
    rescue StandardError
      []
    end

    def history_write(arr)
      File.write(history_index_path, JSON.pretty_generate(arr))
    rescue StandardError => e
      warn("SkpAI history_write: #{e.message}")
    end

    def sanitize_id(id)
      id.to_s.gsub(/[^a-zA-Z0-9_\-]/, '_')[0, 64]
    end

    def history_media_path(id)
      File.join(history_media_dir, "#{sanitize_id(id)}.png")
    end

    def history_add(meta_json, data_url)
      entry = JSON.parse(meta_json)
      return nil unless entry.is_a?(Hash) && entry['id']

      if data_url && data_url.start_with?('data:')
        _, payload = data_url.split(',', 2)
        File.binwrite(history_media_path(entry['id']), Base64.decode64(payload)) if payload
      end

      arr = history_index
      arr.unshift(entry)
      if arr.length > HISTORY_MAX
        arr[HISTORY_MAX..-1].each { |e| delete_media(e['id']) }
        arr = arr[0, HISTORY_MAX]
      end
      history_write(arr)
      entry
    rescue StandardError => e
      warn("SkpAI history_add: #{e.message}")
      nil
    end

    # Full-res PNG for an entry as a data: URI (nil if missing).
    def history_full(id)
      path = history_media_path(id)
      return nil unless File.exist?(path)
      "data:image/png;base64,#{Base64.strict_encode64(File.binread(path))}"
    rescue StandardError
      nil
    end

    def delete_media(id)
      path = history_media_path(id)
      File.delete(path) if File.exist?(path)
    rescue StandardError
      nil
    end

    def history_delete(id)
      history_write(history_index.reject { |e| e['id'] == id })
      delete_media(id)
    rescue StandardError => e
      warn("SkpAI history_delete: #{e.message}")
    end

    def history_clear
      history_index.each { |e| delete_media(e['id']) }
      history_write([])
    rescue StandardError => e
      warn("SkpAI history_clear: #{e.message}")
    end

    def history_export(id)
      src = history_media_path(id)
      return nil unless File.exist?(src)

      dir  = Sketchup.active_model && !Sketchup.active_model.path.to_s.empty? ? File.dirname(Sketchup.active_model.path) : history_dir
      dest = UI.savepanel('Export render', dir, "skpai_#{sanitize_id(id)}.png")
      return nil unless dest

      FileUtils.cp(src, dest)
      dest
    rescue StandardError => e
      UI.messagebox("SkpAI export failed: #{e.message}")
      nil
    end

    # Writes a data: URI (data:<mime>;base64,<payload>) to a user-chosen file.
    def save_data_url(filename, data_url)
      return nil unless data_url && data_url.start_with?('data:')

      header, payload = data_url.split(',', 2)
      return nil unless payload

      ext = header.include?('image/png') ? 'png' : (header.include?('mp4') ? 'mp4' : 'bin')
      default = filename && !filename.empty? ? filename : "skpai_output.#{ext}"

      dir  = Sketchup.active_model && Sketchup.active_model.path && !Sketchup.active_model.path.empty? ? File.dirname(Sketchup.active_model.path) : temp_dir
      dest = UI.savepanel('Save SkpAI output', dir, default)
      return nil unless dest

      File.binwrite(dest, Base64.decode64(payload))
      dest
    rescue StandardError => e
      UI.messagebox("SkpAI save failed: #{e.message}")
      nil
    end

    def push(dialog, js)
      dialog.execute_script(js) if dialog && dialog.visible?
    end

    def temp_dir
      dir = File.join(Dir.tmpdir, 'skpai')
      FileUtils.mkdir_p(dir)
      dir
    rescue StandardError
      Dir.tmpdir
    end
  end

  # --- Menu / toolbar registration (runs once) ---------------------------
  unless defined?(@ui_ready) && @ui_ready
    menu = UI.menu('Extensions')
    menu.add_item('SkpAI — AI Render') { SkpAI.show_dialog }

    cmd = UI::Command.new('SkpAI') { SkpAI.show_dialog }
    cmd.tooltip = 'SkpAI — AI Render'
    cmd.status_bar_text = 'Render the viewport with nano-banana-2 + Seedance 2'
    toolbar = UI::Toolbar.new('SkpAI')
    toolbar.add_item(cmd)
    toolbar.restore

    @ui_ready = true
  end
end
