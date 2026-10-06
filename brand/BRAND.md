# Pointsman brand

Pointsman is an open-source decision service: systems send it a question, it decides which way the question goes — or hands it to a human when it is not sure. The name is the railway worker who sets the points.

**Tagline:** Pointsman sets the switches.

## The mark

A point lever, thrown. Four parts, one weight:

- **Rail** — the base the lever stands on
- **Pivot** — solid dot on the rail
- **Lever** — thick bar, thrown to the right
- **Knob** — green dot: the decision that was made
- **Ghost** — thin bar: the position the lever could have taken

No locomotives, no tracks, no scenes. If a use needs more than these shapes, use the lockup or the wordmark instead.

## Files

```
mark.svg                 primary mark, ink on transparent
mark-on-dark.svg         cream on transparent (dark backgrounds)
mark-mono.svg            single colour, uses currentColor
favicon.svg              32 px, same geometry
tile-ink.svg             512 px rounded tile — GitHub avatar, app icon
tile-cream.svg           light tile
wordmark.svg             "Pointsman", outlined type
wordmark-on-dark.svg
lockup.svg               mark + wordmark, horizontal
lockup-on-dark.svg
social-preview-1280x640.svg   GitHub social preview
png/                     raster exports (16–1024 px, 1x/2x/4x)
```

All type is outlined — no font dependency.

## Colour

| Role | Hex | Use |
| --- | --- | --- |
| Ink | `#171717` | Mark and type on light backgrounds |
| Cream | `#F5F2EC` | Light background; mark and type on dark |
| Dark | `#141414` | Dark background |
| Green | `#2E9E6B` | Knob only. The one accent. |

Green marks the decision that was taken — it is a "go", never a status colour elsewhere in the UI. On a green tile the knob becomes dark.

Single colour: `mark-mono.svg`. Every part including the knob takes `currentColor`. Use it for print, embossing, monochrome UI, and anywhere colour cannot be guaranteed.

## Type

Wordmark: **IBM Plex Mono SemiBold**, letter-spacing −4 %. Do not retype it; use the SVG.

For UI and documents around the brand, IBM Plex Mono (headings, code) with a plain system sans for body copy works well. Nothing else is required.

## Sizing and space

- Mark: never below **16 px**. At 16 px use `favicon.svg` or the PNGs — the geometry is tuned for it.
- Lockup: never below **24 px** tall.
- Clear space around mark or lockup: the height of the knob (3/24 of the mark's height) on all sides.
- In the lockup the rail sits on the wordmark baseline. Keep that alignment if you rebuild it.

## Backgrounds

Light (cream or white): ink mark. Dark (`#141414` or similar): cream mark. On busy or photographic backgrounds use a tile.

## Don't

- Recolour the lever, rail, or pivot
- Change the knob to red, amber, or any status colour
- Rotate, flip, or straighten the lever
- Add gradients, shadows, outlines, or 3-D
- Add trains, tracks, signals, or any scene around the mark
- Place the mark inside another shape (except the supplied tiles)
- Rebuild the wordmark in a different typeface or weight

## Licence

Logo assets are part of the Pointsman project and follow the repository licence. IBM Plex is licensed under the SIL Open Font License; the outlined wordmark carries no font files.
