# ii Engine icon sheet — generation prompt

Paste this into an image model (Ideogram / Flux / Midjourney / GPT Image) to get one reference sheet of every icon. Save the PNG and send it back so we can refine the SVG set to match.

---

**Prompt:**

```
UI icon sheet for a desktop game launcher called "ii Engine", flat 2D, single style across the whole sheet.

Layout: clean white (#F5F5F5) background, 8 columns × 6 rows of icons, equal spacing, each cell has a thin gray label under the glyph. No mockups, no screenshots, no 3D, no shadows, no fills inside shapes, no orange accent dots.

Style: minimalist outlined line icons only. 1.75px consistent stroke weight, round line caps and joins, optical size ~24×24 in each cell, monochrome black (#1A1A1A) strokes on white. Same visual language as Lucide/SF Symbols but original marks — not copies of brand logos except Discord.

Icons to draw (exact labels under each):

Row 1 — Navigation:
1. home — simple house with door cutout
2. health — outlined heart
3. mods — isometric cube / package (3D box outline)
4. community — two people busts (group)
5. announcements — megaphone / bullhorn
6. backups — stacked database cylinders (3 disks)
7. studio — desktop monitor with stand
8. developer — code brackets < >

Row 2 — Account & tools:
9. settings — classic gear / cog
10. customize — sunburst dial (circle with rays)
11. plans — three horizontal stacked bars / tiers
12. tracker — concentric radar / spiral arcs with a tip
13. soundlab — headphones with antenna
14. experimental — chemistry flask
15. trusted — shield with checkmark
16. discord — Discord-style game-controller face (friendly, recognizable)

Row 3 — Launch & repair:
17. play — right-pointing triangle
18. scan — four corner brackets with center line (scan frame)
19. wrench — adjustable wrench
20. folder — file folder
21. help — circle with question mark
22. bell — notification bell
23. refresh — two curved arrows forming a circle
24. external — box with arrow pointing out top-right

Row 4 — Content & status:
25. download — arrow down into tray
26. upload — arrow up from tray
27. check — simple checkmark
28. check-circle — circle with checkmark
29. shield — plain shield outline
30. document — page with folded corner
31. puzzle — puzzle piece
32. search — magnifying glass

Row 5 — UI chrome:
33. plus — plus sign
34. close — X
35. chevron-right — >
36. chevron-down — v
37. arrow-right — long arrow right
38. user — single person bust
39. users — two people (same as community, slightly simpler)
40. more — three horizontal dots

Row 6 — Extra / features:
41. ai — four-point sparkle / star burst
42. zap — lightning bolt
43. bot — friendly robot head
44. music — music note
45. terminal — terminal window with prompt caret
46. clock — analog clock face
47. warning — triangle with exclamation
48. trash — trash can
49. copy — overlapping rectangles
50. image — landscape picture frame
51. layout — window layout with sidebar
52. palette — artist palette
53. type — text “T” / typography mark
54. sparkles — small sparkle cluster
55. gift — gift box with bow
56. pin — pushpin
57. link — chain link
58. lightbulb — light bulb
59. list — checklist / bullet list
60. cone — traffic cone (brand mark, still outline-only)

Constraints: perfectly aligned grid, identical stroke weight on every icon, no color except black lines, no gradients, no glow, no filled shapes (hollow outlines only), high resolution 4K sheet, print-clear labels in a clean sans font under each cell.
```

---

After you generate the sheet, send the PNG here. I’ll rebuild any weak SVGs to match your sheet while keeping the in-app `EngineIcon` API the same.
