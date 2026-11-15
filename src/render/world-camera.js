// 相机机位：蓝图（blend 0，几乎正交）→ 实景（blend 1，略带俯视和偏航）的推拉变焦。
// 纯数学，不依赖渲染器，node 里可以直接测试。
//
// blend 0 时，对 z = 0 平面上的点，3D 相机的投影与蓝图画布的映射完全一致：
//   screen = ( w/2 + (x - cx) * ppm ,  h/2 - (y - cy) * ppm )

const DEG = Math.PI / 180;

export const CAM = {
  D0: 600,            // blend 0 时的相机距离（远到近乎正交）
  dFactor: 1.6,       // blend 1 时 D1 = clamp(1.6 * Hm, dMin, dMax)
  dMin: 30,
  dMax: 110,
  yaw1: -7 * DEG,     // 偏向我方一侧，左边的堡垒稍近
  pitch1: 6 * DEG,    // 稍微俯视，看得出水面和崖顶的纵深
};

function smooth(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }

/** 由共享视图和 blend 计算机位，写入 out（不分配） */
export function computeRig(view, blend, out) {
  const Hm = view.h / view.ppm;
  const D1 = Math.min(CAM.dMax, Math.max(CAM.dMin, CAM.dFactor * Hm));
  const e = smooth(blend);
  const D = Math.exp(Math.log(CAM.D0) + (Math.log(D1) - Math.log(CAM.D0)) * e);
  const yaw = CAM.yaw1 * e, pitch = CAM.pitch1 * e;
  const tx = view.cx, ty = view.cy, tz = 0;
  const cp = Math.cos(pitch);
  out.tx = tx; out.ty = ty; out.tz = tz;
  out.px = tx + D * Math.sin(yaw) * cp;
  out.py = ty + D * Math.sin(pitch);
  out.pz = tz + D * Math.cos(yaw) * cp;
  out.fov = 2 * Math.atan((Hm / 2) / D) / DEG;
  out.aspect = view.w / view.h;
  out.near = Math.max(0.5, D - 160);
  out.far = D + 500;
  out.D = D;
  out.Hm = Hm;
  out.e = e;
  return out;
}

/** 把机位应用到 PerspectiveCamera；(ox, oy, oz) 是震屏位移，同时加到相机和注视点上 */
export function applyRig(camera, rig, ox = 0, oy = 0, oz = 0) {
  camera.position.set(rig.px + ox, rig.py + oy, rig.pz + oz);
  camera.fov = rig.fov;
  camera.aspect = rig.aspect;
  camera.near = rig.near;
  camera.far = rig.far;
  camera.lookAt(rig.tx + ox, rig.ty + oy, rig.tz + oz);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

export function newRig() {
  return { tx: 0, ty: 0, tz: 0, px: 0, py: 0, pz: 0, fov: 45, aspect: 1, near: 0.5, far: 1000, D: 600, Hm: 30, e: 0 };
}
