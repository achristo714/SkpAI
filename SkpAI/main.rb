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
    end

    # Renders the active view to a temp PNG, scaled to CAPTURE_LONG_EDGE on
    # its long edge, and returns it as a data: URI. nil if nothing is open.
    def capture_viewport
      model = Sketchup.active_model
      return nil unless model

      view = model.active_view
      return nil unless view

      vw = view.vpwidth.to_f
      vh = view.vpheight.to_f
      return nil if vw <= 0 || vh <= 0

      scale = CAPTURE_LONG_EDGE / [vw, vh].max
      scale = 1.0 if scale > 1.0 # never upscale
      w = (vw * scale).round
      h = (vh * scale).round

      tmp = File.join(temp_dir, "skpai_capture_#{Time.now.to_i}.png")
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
