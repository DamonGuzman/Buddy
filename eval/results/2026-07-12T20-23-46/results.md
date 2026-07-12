# Pointing eval — 2026-07-12T20:23:46.976Z

Backend: **LIVE OPENAI API** — mode: **text**



| scene | target | verdict | error px | raw verdict | snap (name @ score, ms) | pointed (global DIP) | target rect |
|---|---|---|---:|---|---|---|---|
| calibration | calibration-center | hit | 0 | hit | no match, 370ms | 1280,720 | 768,475 1024x490 |
| app-toolbar | menu-file | hit | 0 | hit | "File" @ 1, 86ms | 39.333335876464844,23.33333396911621 | 24,10 30x27 |
| app-toolbar | save | hit | 1 | hit | "💾 Save" @ 1, 40ms | 106,102.66667175292969 | 24,66 163x73 |
| app-toolbar | open | hit | 1 | near | "📂 Open" @ 1, 49ms | 298,102.66667175292969 | 211,66 173x73 |
| app-toolbar | export | hit | 0 | miss | "⇮ Export" @ 1, 51ms | 488.66668701171875,102.66667175292969 | 408,65 161x75 |
| app-toolbar | settings | hit | 1 | miss | "⚙ Settings" @ 1, 42ms | 686,102.66667175292969 | 593,66 185x73 |
| app-toolbar | share | hit | 0 | miss | "🔗 Share" @ 1, 39ms | 889.3333740234375,102.66667175292969 | 802,66 174x73 |
| form | email | hit | 1 | near | "Email address" @ 1, 75ms | 1280,654 | 1025,622 511x64 |
| form | password | hit | 1 | miss | "Password" @ 1, 36ms | 1280,773.3333740234375 | 1025,741 511x64 |
| form | subscribe | hit | 0 | miss | "Send me the monthly product newsletter" @ 0.7, 45ms | 1038,848 | 1025,835 26x26 |
| form | submit | hit | 1 | miss | "Create account" @ 1, 42ms | 1280,932.6666870117188 | 1025,899 511x67 |
| shop | search | hit | 1 | miss | "Search headphones, speakers, accessories…" @ 0.7, 85ms | 568,52 | 188,25 760x55 |
| shop | cart | hit | 23 | hit | no match, 81ms | 2485,68.75 | 2427,20 85x64 |
| shop | reviews | hit | 1 | miss | "2,418 customer reviews" @ 0.8, 53ms | 964.6666870117188,249.33334350585938 | 856,235 216x28 |
| shop | price | miss | 168 | miss | no match, 90ms | 968.75,337.5 | 720,289 164x59 |
| shop | add-to-cart | hit | 1 | miss | "Add to cart" @ 1, 46ms | 830.6666870117188,568.6666870117188 | 720,532 220x73 |
| tricky | small-icon | near | 19 | near | no match, 69ms | 2512.5,52.5 | 2504,22 24x24 |
| tricky | save | hit | 0 | near | "Save" @ 1, 36ms | 1029.3333740234375,320.66668701171875 | 973,291 112x59 |
| tricky | save-as | hit | 0 | miss | "Save As" @ 1, 34ms | 1175.3333740234375,320.66668701171875 | 1105,291 140x59 |
| tricky | edge-button | hit | 0 | hit | "? Help" @ 1, 35ms | 2508.666748046875,1410 | 2466,1388 86x44 |

**Summary:** 18 hit / 1 near / 1 miss / 0 error (of 20)

**Snap attribution:** 16/20 snapped; raw would have been 5 hit / 4 near / 11 miss; snap saved 13, broke 0; median snap 48ms
