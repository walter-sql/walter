export interface PgSnapshot {
  xmin: bigint;
  xmax: bigint;
  xip: ReadonlySet<bigint>;
}

const NO_XIPS: ReadonlySet<bigint> = new Set();

export function absorbedThrough(n: number | bigint): PgSnapshot {
  const next = BigInt(n) + 1n;
  return { xmin: next, xmax: next, xip: NO_XIPS };
}

export function parseSnapshot(text: string): PgSnapshot {
  const [xmin, xmax, xip] = text.split(":");
  return {
    xmin: BigInt(xmin!),
    xmax: BigInt(xmax!),
    xip: xip ? new Set(xip.split(",").map(BigInt)) : NO_XIPS
  };
}

export function parseLsn(text: string): bigint {
  const [hi, lo] = text.split("/");
  return (BigInt(`0x${hi}`) << 32n) | BigInt(`0x${lo}`);
}

export function absorbed(snap: PgSnapshot, xid: number): boolean {
  const x = toXid8(xid, snap.xmax);
  return x < snap.xmin || (x < snap.xmax && !snap.xip.has(x));
}

const XID_SPAN = 1n << 32n;
const HALF_SPAN = 1n << 31n;

function toXid8(xid: number, ref: bigint): bigint {
  let x = (ref & ~(XID_SPAN - 1n)) | BigInt(xid >>> 0);
  if (x > ref + HALF_SPAN) x -= XID_SPAN;
  else if (x + HALF_SPAN < ref) x += XID_SPAN;
  return x;
}
