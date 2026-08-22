const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const OCR_API_KEY = process.env.OCR_API_KEY;

app.post('/scan', async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body;
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
    const lines = fullText.split('\n');

    let ms = null, hsd = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineLower = line.toLowerCase();

      if (/cum\s*vol/i.test(line)) {
        // Try to find number on same line
        const nums = line.match(/\d{3,}\.?\d*/g);
        const found = nums ? parseFloat(nums[nums.length - 1]) : null;

        // Try next line if not found on same line
        let val = found;
        if (!val && i + 1 < lines.length) {
          const nextNums = lines[i + 1].match(/\d{3,}\.?\d*/g);
          if (nextNums) val = parseFloat(nextNums[0]);
        }

        if (val) {
          // Determine if MS or HSD by looking at surrounding context
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

    // Fallback: if only one found, try scanning all large numbers near CumVol
    res.json({ ms: ms ?? null, hsd: hsd ?? null, rawText: fullText });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Fuel Sales Tracker API running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
