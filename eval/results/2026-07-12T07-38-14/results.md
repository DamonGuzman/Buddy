# Pointing eval — 2026-07-12T07:38:14.158Z

Backend: **MOCK (tools/mock-realtime)** — mode: **text**

> Mock run: validates plumbing only (mock always points at screen center). Only the calibration target is expected to hit.

| scene | target | verdict | error px | pointed (global DIP) | target rect |
|---|---|---|---:|---|---|
| calibration | calibration-center | hit | 0 | 1280,720 | 768,475 1024x490 |
| app-toolbar | menu-file | miss | 1423 | 1280,720 | 24,10 30x27 |
| app-toolbar | save | miss | 1327 | 1280,720 | 24,66 163x73 |
| app-toolbar | open | miss | 1160 | 1280,720 | 211,66 173x73 |
| app-toolbar | export | miss | 1004 | 1280,720 | 408,65 161x75 |
| app-toolbar | settings | miss | 857 | 1280,720 | 593,66 185x73 |
| app-toolbar | share | miss | 731 | 1280,720 | 802,66 174x73 |
| form | email | near | 66 | 1280,720 | 1025,622 511x64 |
| form | password | near | 53 | 1280,720 | 1025,741 511x64 |
| form | subscribe | miss | 274 | 1280,720 | 1025,835 26x26 |
| form | submit | miss | 213 | 1280,720 | 1025,899 511x67 |
| shop | search | miss | 976 | 1280,720 | 188,25 760x55 |
| shop | cart | miss | 1364 | 1280,720 | 2427,20 85x64 |
| shop | reviews | miss | 567 | 1280,720 | 856,235 216x28 |
| shop | price | miss | 624 | 1280,720 | 720,289 164x59 |
| shop | add-to-cart | miss | 475 | 1280,720 | 720,532 220x73 |
| tricky | small-icon | miss | 1414 | 1280,720 | 2504,22 24x24 |
| tricky | save | miss | 472 | 1280,720 | 973,291 112x59 |
| tricky | save-as | miss | 413 | 1280,720 | 1105,291 140x59 |
| tricky | edge-button | miss | 1409 | 1280,720 | 2466,1388 86x44 |

**Summary:** 1 hit / 2 near / 17 miss / 0 error (of 20)
