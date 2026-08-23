const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const OCR_API_KEY = process.env.OCR_API_KEY;

// Nozzle No1 = MS, Nozzle No2 = HSD (based on actual slip)
const DU_NOZZLE_MAP = {
  DU1: { 1: 'ms', 2: 'hsd' },
  DU2: { 1: 'ms', 2: 'hsd' }
};
const DEFAULT_NOZZLE_MAP = { 1: 'ms', 2: 'hsd' };

app.post('/scan', async (req, res) => {
  try {
    const { imageBase64, mimeType, du } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

    // Always send as JPEG — OCR.space works best with jpeg/png
    const mime = 'image/jpeg';

    // Try OCREngine 2 first (better for printed receipts), fallback to 1
    async function runOCR(engine) {
      const ocrResponse = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apikey: OCR_API_KEY,
          base64Image: `data:${mime};base64,${imageBase64}`,
          language: 'eng',
          isOverlayRequired: false,
          detectOrientation: true,
          scale: true,
          isTable: false,
          OCREngine: engine
        })
      });
      const data = await ocrResponse.json();
      if (data.IsErroredOnProcessing) throw new Error(data.ErrorMessage?.[0] || 'OCR error');
      return data.ParsedResults?.[0]?.ParsedText || '';
    }

    let fullText = await runOCR(2);
    console.log('OCR Engine 2 result:\n', fullText);

    // If CumVolume not found, try engine 1
    if (!/cumvolume|cum\s*volume/i.test(fullText)) {
      console.log('Retrying with OCR Engine 1...');
      fullText = await runOCR(1);
      console.log('OCR Engine 1 result:\n', fullText);
    }

    const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
    let ms = null, hsd = null;

    function findNumberFrom(startIdx) {
      for (let j = startIdx; j < Math.min(startIdx + 4, lines.length); j++) {
        // Match large decimals like 89293.390
        const nums = lines[j].match(/\d{3,}\.?\d*/g);
        if (nums) return parseFloat(nums[nums.length - 1]);
      }
      return null;
    }

    // Strategy 1: Nozzle-based (your slip format)
    const nozzleCumVol = {};
    let currentNozzle = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match "Nozzle No1", "Nozzle No 1", "Nozzle1", "NozzleNo1" etc
      const nm = line.match(/nozzle\s*n[o0]\.?\s*(\d+)/i) || line.match(/nozzle\s*(\d+)/i);
      if (nm) { currentNozzle = parseInt(nm[1]); continue; }

      if (currentNozzle && /cum\s*v[o0]l/i.test(line) && !(currentNozzle in nozzleCumVol)) {
        const val = findNumberFrom(i);
        if (val != null) {
          nozzleCumVol[currentNozzle] = val;
          console.log(`Nozzle ${currentNozzle} CumVolume: ${val}`);
        }
      }
    }

    if (Object.keys(nozzleCumVol).length) {
      const nozzleMap = DU_NOZZLE_MAP[du] || DEFAULT_NOZZLE_MAP;
      for (const [n, val] of Object.entries(nozzleCumVol)) {
        const product = nozzleMap[Number(n)];
        if (product === 'ms' && ms === null) ms = val;
        if (product === 'hsd' && hsd === null) hsd = val;
      }
    }

    // Strategy 2: Fallback — find any CumVolume lines
    if (ms === null || hsd === null) {
      let cumCount = 0;
      for (let i = 0; i < lines.length; i++) {
        if (/cum\s*v[o0]l/i.test(lines[i])) {
          const val = findNumberFrom(i);
          if (val) {
            cumCount++;
            if (cumCount === 1 && ms === null) ms = val;
            else if (cumCount === 2 && hsd === null) hsd = val;
          }
        }
      }
    }

    console.log(`Final result — MS: ${ms}, HSD: ${hsd}`);
    res.json({ ms: ms ?? null, hsd: hsd ?? null, rawText: fullText });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Fuel Sales Tracker API running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
