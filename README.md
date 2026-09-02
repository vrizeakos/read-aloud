# Read Aloud

Turns a research paper into speech in the browser. Text is extracted with
pdf.js and spoken by the Kokoro-82M model running locally through kokoro-js,
so no audio or document ever leaves the machine. The model (about 90 MB) is
downloaded from Hugging Face on first use and cached by the browser.

Features

- Drag and drop or open a PDF, Markdown or plain text file, or paste text
- Paper mode: reads two column layouts in order and sets aside running
  headers, footers, page numbers, figure labels, tables, footnotes, equations,
  captions and the reference list, with a checkbox for each kind
- Citations such as `[12]` or `(Smith et al., 2020)` are stripped from the
  speech, and abbreviations like `Fig. 4` or `e.g.` are read out in full
- Every block that was set aside shows up greyed in the text; click it to
  read it anyway, or use the tag on a block to set it aside
- 28 English voices (American and British), adjustable speed, page range
- Play, pause, skip by sentence, click any sentence to jump
- Follow-along highlighting
- Download the selected pages as a WAV file
- Uses WebGPU when available, falls back to WASM

## How paper mode works

`src/layout.js` pulls every text run out of the PDF with its position, size
and font. `src/paper.js` groups runs into lines, detects a two column layout
from the empty gutter between the columns, orders the lines for reading,
builds blocks from spacing, indentation and font changes, and classifies each
block: title, authors, heading, body text, caption, table, figure label,
equation, footnote, running header or footer, page number, reference. Blocks
are then cleaned for speech (ligatures, hyphenation at line ends, citations,
abbreviations, symbols) and split into sentences by `src/sentences.js`.

The heuristics are tuned on common templates (CVPR, ACL, NeurIPS, arXiv).
Unusual layouts will misclassify the odd block, which is why every decision
can be reversed in the text with one click. For the most demanding documents,
run a scholarly parser such as GROBID, Marker or Docling first and open the
Markdown or text it produces.

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
