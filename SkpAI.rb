# frozen_string_literal: true
#
# SkpAI — AI Render for SketchUp
# Registrar file. SketchUp requires the top-level extension file to live
# next to a folder of the same base name that holds the implementation.
#
# Renders the active viewport with fal.ai nano-banana-2, then turns the
# still into a short video with Seedance 2. Ships a dark, Teenage
# Engineering "field" styled panel.

require 'sketchup.rb'
require 'extensions.rb'

module SkpAI
  PLUGIN_NAME    = 'SkpAI — AI Render'
  PLUGIN_VERSION = '0.1.0'
  PLUGIN_ID      = 'skpai_ai_render'

  # Path to the implementation folder (SkpAI/) that sits beside this file.
  ROOT = File.dirname(__FILE__)

  unless defined?(@loaded) && @loaded
    ext = SketchupExtension.new(PLUGIN_NAME, File.join(ROOT, 'SkpAI', 'main'))
    ext.description = 'Render the SketchUp viewport with nano-banana-2 and ' \
                      'generate video with Seedance 2. Reference-image ' \
                      'material matching + prompt enhancer.'
    ext.version     = PLUGIN_VERSION
    ext.creator     = 'SkpAI'
    ext.copyright   = "© #{Time.now.year}"

    Sketchup.register_extension(ext, true)
    @loaded = true
  end
end
