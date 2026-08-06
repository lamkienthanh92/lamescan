// Any canvas whose pixels get read back — by cv.imread, which calls getImageData
// internally, or by getImageData directly — must be created with
// willReadFrequently. Without it the browser keeps the canvas on the GPU and every
// readback forces a synchronous stall to pull the pixels back across, which the
// console warns about and which is real cost on a loop sampling frames several
// times a second.
//
// The attribute is fixed when the 2D context is first created and cannot be changed
// afterwards, so it has to be requested before anything else touches the canvas —
// including before handing it to cv.imread, which would otherwise create the
// context itself with the default settings.
export function readbackCanvas(w, h) {
  const c = document.createElement('canvas');
  if (w) c.width = w;
  if (h) c.height = h;
  c.getContext('2d', { willReadFrequently: true });
  return c;
}
