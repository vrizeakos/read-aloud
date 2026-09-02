# Read Aloud

Turns a PDF into speech in the browser. Text is extracted with pdf.js and
spoken by the Kokoro-82M model running locally through kokoro-js, so no
audio or document ever leaves the machine. The model (about 90 MB) is
downloaded from Hugging Face on first use and cached by the browser.

Features

- Drag and drop or choose a PDF, pick a page range
- 28 English voices (American and British), adjustable speed
- Play, pause, skip by sentence, click any sentence to jump
- Follow-along highlighting
- Download the selected pages as a WAV file
- Uses WebGPU when available, falls back to WASM

## Run locally

```
npm install
npm run dev
```

## Deploy to GitHub Pages

1. Create a new repository on GitHub and push this folder to the `main` branch.
2. In the repository go to Settings, then Pages, and under "Build and deployment"
   set Source to "GitHub Actions".
3. The workflow in `.github/workflows/deploy.yml` builds and publishes on every
   push to `main`. The site appears at `https://<user>.github.io/<repo>/`.

`vite.config.js` uses `base: "./"`, so the build works under any repository
name without changes.

## Notes

- Scanned PDFs contain images, not text, and need OCR first.
- WebGPU (Chrome, Edge, recent Safari) generates speech faster than real time.
  Firefox and older browsers use WASM, which is slower but works.
- Speech is generated sentence by sentence a few sentences ahead of playback,
  so the first sentence starts within a second or two on a GPU.
