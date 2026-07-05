# SkpAI — AI Render for SketchUp

Render the active SketchUp viewport with **nano-banana-2** (fal.ai), then turn
the still into a short clip with **Seedance 2** — a simple *dolly-in* or
*timelapse*. Drop in a reference image and nano-banana-2 matches your materials
and mood to it. Weak prompts get automatically upgraded by a built-in prompt
enhancer. Dark, Teenage-Engineering "field" styled panel.

![module: 00 connect · 01 capture · 02 prompt · 03 aesthetic ref · 04 render · 05 video](docs/panel.png)

---

## What it does

| # | Module | Action |
|---|--------|--------|
| 00 | **connect** | Enter & save your fal.ai API key (stored locally). |
| 01 | **capture** | Grabs the current viewport as a PNG (scaled to 1536px long edge). |
| 02 | **prompt** | Your brief. A live *strength* meter flags weak prompts; **✧ enhance** rewrites them with a fal text model. |
| 03 | **aesthetic ref** | Drop a material / mood image. Passed to nano-banana-2 as a second image so output materials match. |
| 04 | **render · nb2** | Sends viewport (+ reference) to `nano-banana-2` and shows the result. Auto-enhances a weak prompt first. |
| 05 | **video · seedance 2** | Uses the render as the first frame → *dolly in* or *timelapse* clip via `seedance/v2`. |

The Ruby side is intentionally thin — it only owns the menu, the dialog, the
viewport capture, and saving files. All fal.ai traffic runs from JavaScript
inside the dialog's embedded Chromium.

---

## Install

1. **Zip the plugin** into an `.rbz`:

   ```bash
   # from the repo root — the archive must contain SkpAI.rb + SkpAI/ at its top level
   zip -r SkpAI.rbz SkpAI.rb SkpAI
   ```

2. In SketchUp: **Extensions → Extension Manager → Install Extension…** and pick
   `SkpAI.rbz`.
3. Open the panel from **Extensions → SkpAI — AI Render** (or the *SkpAI* toolbar).
4. Paste your fal.ai key (module **00**) and **save**.

Requires **SketchUp 2017+** (uses `UI::HtmlDialog`).

---

## Configuration

fal.ai occasionally renames model slugs. All endpoint IDs live at the top of
`SkpAI/html/app.js` — edit them there if a model moves:

```js
const FAL = {
  RENDER:    'fal-ai/nano-banana-2/edit',            // still render
  VIDEO:     'fal-ai/bytedance/seedance/v2/image-to-video', // video
  LLM:       'fal-ai/any-llm',                        // prompt enhancer
  LLM_MODEL: 'google/gemini-flash-1.5',
};
```

Camera-motion prompt presets (`dolly`, `timelapse`) are in the `MOTION` object
just below — tweak the wording or add your own moves there.

---

## Notes

- **API key** is kept in `localStorage` and mirrored to SketchUp's defaults, so
  it survives restarts. It never leaves your machine except in the
  `Authorization` header of your own fal.ai requests.
- **Images** are sent to fal as `data:` URIs (viewport + reference), so no
  separate upload step is needed.
- **Cost / speed**: the viewport is downscaled to 1536px before upload to keep
  renders fast and cheap. Adjust `CAPTURE_LONG_EDGE` in `SkpAI/main.rb`.
- If the dialog can't reach fal (CORS / offline), errors surface in the in-panel
  **console** at the bottom.

---

## Layout

```
SkpAI.rb              # extension registrar (required next to SkpAI/)
SkpAI/
  main.rb            # menu, HtmlDialog, viewport capture, file save
  html/
    dialog.html      # panel markup
    style.css        # dark / Teenage Engineering field styling
    app.js           # fal.ai calls, enhancer, render, video, bridge
```
