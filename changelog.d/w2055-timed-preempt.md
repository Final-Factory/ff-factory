- **Timed legs pre-empt small computers, by size class** (w2055): computers have a size class from their agent slots (small
  1, medium 2-3, large 4-6, xlarge 7+), shown in the logs and the Capacity timed line. A Queued timed leg starts on an idle
  computer (no other work at all), smallest class first; else FF Factory moves a small computer's movable workers (between
  turns, everything committed and pushed, nothing in flight) to another computer and starts the leg there; else a high or
  urgent leg goes to a big computer at once and a normal or low one waits on the small ones. With every small computer
  offline the next class is used at once. Biscuit (4 slots) is large now.
