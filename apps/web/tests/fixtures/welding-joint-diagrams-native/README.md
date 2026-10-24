# Synthetic native decoder inputs

These ten images are test data, not welding designs. `generate.py` creates a 96×64 four-quadrant RGB image: red top-left, green top-right, blue bottom-left, yellow bottom-right. PNG and WebP are lossless; eight JPEG files retain the same encoded pixels and carry EXIF orientation 1–8. JPEG uses quality 95 without chroma subsampling.

The native spec independently lists all eight expected corner permutations. It verifies actual Chrome `Image` dimensions and canvas samples, with a maximum per-channel JPEG difference of 12. The manifest pins raw bytes, size, format and expected display dimensions. The generator is one-time preparation tooling; tests never regenerate fixtures.

The empty-page wrapper executes the current binary client with explicit synthetic token/signature and controlled authority/diagram responses. This does not exercise domain HTTP, real SSO, the Vue component, or professional drawing suitability. The separate Vue DOM suite uses an image stub and must not be called native decoding evidence.
