const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' })); // frontend compresses images to ~700KB, this is just a safety margin

const OCR_API_KEY = process.env.OCR_API_KEY;
if (!OCR_API_KEY) {
  console.warn('⚠️  OCR_API_KEY is not set — /scan will fail until it is added in Render → Environment.');
}

// Each DU has its nozzles wired to different products — set per real station wiring.
// DU1: Nozzle 1 = HSD, Nozzle 2 = MS
// DU2: Nozzle 1 = MS,  Nozzle 2 = HSD
const DU_NOZZLE_MAP = {
  DU1: { 1: 'hsd', 2: 'ms' },
  DU2: { 1: 'ms', 2: 'hsd' }
};
// Used if an unrecognized/missing DU value is sent, so scanning still works.
const DEFAULT_NOZZLE_MAP = { 1: 'ms', 2: 'hsd' };

app.post('/scan', async (req, res) => {
  try {
    const { imageBase64, mimeType, du } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

    if (!OCR_API_KEY) {
      return res.status(500).json({ error: 'Server misconfigured: OCR_API_KEY is not set (check Render → Environment)' });
    }

    // OCR.space's free tier rejects images over 1MB — fail fast with a clear message
    // instead of a confusing OCR-side error, in case a client ever sends an uncompressed photo.
    const approxImageBytes = Math.ceil(imageBase64.length * 3 / 4);
    if (approxImageBytes > 1024 * 1024) {
      return res.status(413).json({ error: `Image too large (${(approxImageBytes/1024/1024).toFixed(1)}MB) — must be under 1MB. Try again or update the app.` });
    }

    async function runOCR(engine) {
      const r = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apikey: OCR_API_KEY,
          base64Image: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}`,
          language: 'eng',
          isOverlayRequired: false,
          detectOrientation: true,
          scale: true,
          OCREngine: engine
        })
      });
      const d = await r.json();
      if (d.IsErroredOnProcessing) throw new Error(d.ErrorMessage?.[0] || 'OCR error');
      return d.ParsedResults?.[0]?.ParsedText || '';
    }

    // Try engine 2 first (usually better for receipts), fall back to engine 1.
    let fullText = await runOCR(2);
    if (!fullText || fullText.trim().length < 20) fullText = await runOCR(1);
    console.log('RAW OCR:\n', fullText);

    // Normalize common OCR misreads before parsing.
    let text = fullText
      .replace(/N[o0]zz?1?e/gi, 'Nozzle')                 // Nozz1e / N0zzle / Nozle -> Nozzle
      .replace(/nozzle\s*no\.?\s*[l|I]\b/gi, 'Nozzle No1') // "No l" / "No I" (digit 1 misread as letter) -> No1
      .replace(/cum\s*vo?1?\s*u?m?e?/gi, (m) => /cum\s*sale/i.test(m) ? m : 'CumVolume') // various CumVolume misreads
      .replace(/CumVolume(\s*CumVolume)+/gi, 'CumVolume') // collapse accidental double-replace
      .replace(/cum\s*sale/gi, 'CumSale');
    console.log('NORMALIZED:\n', text);

    let ms = null, hsd = null;
    const nozzleCumVol = {};

    // === Strategy 1: split into per-nozzle blocks, extract CumVolume from each ===
    // Regex requires the number to come immediately (whitespace only) after "CumVolume",
    // so it can never cross over into a "CumSale" value even if OCR merges them onto one line.
    const nozzleSplit = text.split(/(?=nozzle\s*no\.?\s*\d+)/i);
    for (const block of nozzleSplit) {
      const nozzleMatch = block.match(/nozzle\s*no\.?\s*(\d+)/i);
      if (!nozzleMatch) continue;
      const nozzleNo = parseInt(nozzleMatch[1], 10);
      if (nozzleNo in nozzleCumVol) continue;

      const cumVolMatch = block.match(/CumVolume\s*[:\-]?\s*([\d,]+\.\d+)/i);
      if (cumVolMatch) {
        nozzleCumVol[nozzleNo] = parseFloat(cumVolMatch[1].replace(/,/g, ''));
        console.log(`Nozzle ${nozzleNo} CumVolume = ${nozzleCumVol[nozzleNo]}`);
      }
    }

    if (Object.keys(nozzleCumVol).length) {
      const map = DU_NOZZLE_MAP[du] || DEFAULT_NOZZLE_MAP;
      for (const [n, val] of Object.entries(nozzleCumVol)) {
        const product = map[Number(n)];
        if (product === 'ms' && ms === null) ms = val;
        if (product === 'hsd' && hsd === null) hsd = val;
      }
    }

    // === Strategy 2: sequential fallback — grab CumVolume values in document order ===
    // if nozzle headers weren't detected at all.
    if (ms === null || hsd === null) {
      console.log('Falling back to sequential CumVolume search...');
      const matches = [...text.matchAll(/CumVolume\s*[:\-]?\s*([\d,]+\.\d+)/gi)];
      const map = DU_NOZZLE_MAP[du] || DEFAULT_NOZZLE_MAP;
      matches.forEach((m, idx) => {
        const val = parseFloat(m[1].replace(/,/g, ''));
        const nozzleNo = idx + 1; // 1st CumVolume found = nozzle 1, 2nd = nozzle 2
        const product = map[nozzleNo];
        if (product === 'ms' && ms === null) ms = val;
        if (product === 'hsd' && hsd === null) hsd = val;
      });
    }

    // === Strategy 3: fallback for older slip formats with explicit "MS/HSD ... CumVol" labels ===
    if (ms === null || hsd === null) {
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/cum\s*vol/i.test(line) && !/cumvolume/i.test(line)) {
          const nums = line.match(/\d{3,}\.?\d*/g);
          let val = nums ? parseFloat(nums[nums.length - 1]) : null;
          if (!val && i + 1 < lines.length) {
            const nextNums = lines[i + 1].match(/\d{3,}\.?\d*/g);
            if (nextNums) val = parseFloat(nextNums[0]);
          }
          if (val) {
            const context = lines.slice(Math.max(0, i - 4), i + 1).join(' ').toLowerCase();
            if (/ms|petrol|mogas|motor\s*spirit/.test(context) && ms === null) ms = val;
            else if (/hsd|diesel|high\s*speed/.test(context) && hsd === null) hsd = val;
            else if (ms === null) ms = val;
            else if (hsd === null) hsd = val;
          }
        }
      }
    }

    console.log(`FINAL — MS: ${ms}, HSD: ${hsd}`);
    res.json({ ms: ms ?? null, hsd: hsd ?? null, rawText: fullText });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Fuel Sales Tracker API running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
