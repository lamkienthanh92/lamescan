// 3x3 row-major homogeneous matrix helpers used for panorama compositing.

export const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function matMul3(A, B) {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++)
        r[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return r;
}

export function translateM(tx, ty) {
  return [1, 0, tx, 0, 1, ty, 0, 0, 1];
}

export function applyH(M, x, y) {
  const w = M[6] * x + M[7] * y + M[8];
  return [(M[0] * x + M[1] * y + M[2]) / w, (M[3] * x + M[4] * y + M[5]) / w];
}

export function cornersOf(M, w, h) {
  return [applyH(M, 0, 0), applyH(M, w, 0), applyH(M, w, h), applyH(M, 0, h)];
}

export function bboxOf(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  pts.forEach(([x, y]) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });
  return { minX, minY, maxX, maxY };
}
