const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const OCR_API_KEY = process.env.OCR_API_KEY;

// Each DU has its nozzles wired to different products.
// DU1: Nozzle 1 = HSD, Nozzle 2 = MS
// DU2: Nozzle 1 = MS,  Nozzle 2 = HSD
const DU_NOZZLE_MAP = {
  DU1: { 1: 'hsd', 2: 'ms' },
  DU2: { 1: 'ms', 2: 'hsd' }
};
// Fallback used if an unrecognized/missing DU is sent, so scanning still works.
const DEFAULT_NOZZLE_MAP = { 1: 'ms', 2: 'hsd' };

app.post('/scan', async (req, res) => {
  try {
    const { imageBase64, mimeType, du } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

    // Send image to OCR.space
    const ocrResponse = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey: OCR_API_KEY,
        base64Image: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}`,
        language: 'eng',
        isOverlayRequired: false,
        detectOrientation: true,
        scale: true,
        OCREngine: 2
      })
    });

    const ocrData = await ocrResponse.json();
    if (ocrData.IsErroredOnProcessing) {
      throw new Error(ocrData.ErrorMessage?.[0] || 'OCR processing error');
    }

    const fullText = ocrData.ParsedResults?.[0]?.ParsedText || '';
    const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);

    let ms = null, hsd = null;

    // Grabs the first number found starting at lines[startIdx], checking that
    // line and up to 2 lines after it (handles labels like "CumVolume:" where
    // the value got wrapped onto its own line by a narrow receipt printer).
    function findNumberFrom(startIdx) {
      for (let j = startIdx; j < Math.min(startIdx + 3, lines.length); j++) {
        const nums = lines[j].match(/\d{2,}\.?\d*/g);
        if (nums && nums.length) return parseFloat(nums[nums.length - 1]);
      }
      return null;
    }

    // === Strategy 1: nozzle-based slips ===
    // e.g. "Nozzle No1" ... "CumVolume:" \n "89293.390" ... "Nozzle No2" ... "CumVolume:" \n "52517.410"
    // Which nozzle is MS vs HSD depends on the DU (see DU_NOZZLE_MAP above).
    const nozzleCumVol = {};
    let currentNozzle = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const nozzleMatch = line.match(/nozzle\s*no\.?\s*(\d+)/i);
      if (nozzleMatch) {
        currentNozzle = parseInt(nozzleMatch[1], 10);
        continue;
      }
      if (currentNozzle && /cum\s*volume/i.test(line) && !(currentNozzle in nozzleCumVol)) {
        const val = findNumberFrom(i);
        if (val != null) nozzleCumVol[currentNozzle] = val;
      }
    }
    if (Object.keys(nozzleCumVol).length) {
      const nozzleMap = DU_NOZZLE_MAP[du] || DEFAULT_NOZZLE_MAP;
      for (const [nozzleNo, value] of Object.entries(nozzleCumVol)) {
        const product = nozzleMap[Number(nozzleNo)];
        if (product === 'ms' && ms === null) ms = value;
        if (product === 'hsd' && hsd === null) hsd = value;
      }
    }

    // === Strategy 2 (fallback): explicit "MS/HSD ... CumVol" labeled slips ===
    if (ms === null || hsd === null) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (/cum\s*vol/i.test(line) && !/cum\s*volume/i.test(line)) {
          const nums = line.match(/\d{3,}\.?\d*/g);
          const found = nums ? parseFloat(nums[nums.length - 1]) : null;

          let val = found;
          if (!val && i + 1 < lines.length) {
            const nextNums = lines[i + 1].match(/\d{3,}\.?\d*/g);
            if (nextNums) val = parseFloat(nextNums[0]);
          }

          if (val) {
            const context = lines.slice(Math.max(0, i - 4), i + 1).join(' ').toLowerCase();
            if (/ms|petrol|mogas|motor\s*spirit/.test(context) && ms === null) {
              ms = val;
            } else if (/hsd|diesel|high\s*speed/.test(context) && hsd === null) {
              hsd = val;
            } else if (ms === null) {
              ms = val;
            } else if (hsd === null) {
              hsd = val;
            }
          }
        }
      }
    }

    res.json({ ms: ms ?? null, hsd: hsd ?? null, rawText: fullText });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Fuel Sales Tracker API running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
