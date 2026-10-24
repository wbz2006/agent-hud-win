'use strict';

/**
 * 拖动吸附（胶囊在上/左/右三条边之间移动）的纯几何计算。
 *
 * 对应原 macOS 项目的 HUDDragWindowController + ScreenHUD.beginMoving/move/finishMoving：
 * 按住期间只移动窗口、**不写偏好**；松手才提交一次停靠。
 * 与 macOS 版的差别：本项目不保留任意坐标，胶囊只生活在三条边附近 ——
 * 松手时吸附到**离胶囊中心最近的那条边**（top / left / right），
 * 左右两边是竖条，所以拖动过程中靠近左右边就要就地翻成竖排。
 *
 * 这个模块**不 require electron**：所有尺寸与工作区都从参数传进来，
 * 因此可以直接在 node --test 里跑（见 test/drag.test.js）。
 * 主进程负责提供 win.getBounds() / screen.getDisplayMatching(...).workArea。
 *
 * 术语：
 *   wa     = 目标显示器的可用区域（DIP）
 *   dims   = { barW, barH, sideW, runH } 横条宽/高、竖条厚/长
 *   anchor = 展开方向：横排 'down'，竖排 'right'（左停靠，面板朝右）/'left'（右停靠，面板朝左）
 */

/** 胶囊与屏幕边缘之间留的最小空隙（与 dockRect 的 margin 一致）。 */
const MARGIN = 6;

/** 把左上角夹进工作区，保证 w×h 始终完整可见。 */
function clampPos(x, y, w, h, wa, margin = MARGIN) {
  const minX = wa.x + margin;
  const minY = wa.y + margin;
  const maxX = wa.x + wa.width - margin - w;
  const maxY = wa.y + wa.height - margin - h;
  return {
    // 窗口比工作区还大时没法夹（maxX < minX），退化为贴左上角
    x: maxX < minX ? minX : Math.max(minX, Math.min(maxX, Math.round(x))),
    y: maxY < minY ? minY : Math.max(minY, Math.min(maxY, Math.round(y))),
  };
}

/** 停靠边 → 是否竖排。 */
function isVertical(dock) {
  return dock === 'left' || dock === 'right';
}

/**
 * 停靠边 → 面板展开方向。
 * 三条边的答案是固定的（顶边只能朝下；左边的竖条只能朝屏幕内=右；右边反之），
 * 集中在这里算，免得 CSS、主进程、拖动各写一套判断。
 */
function anchorOf(dock) {
  if (dock === 'left') return 'right';
  if (dock === 'right') return 'left';
  return 'down';
}

/**
 * 离胶囊中心最近的一条吸附边。
 *
 * 只用三条边（没有底边）：胶囊的归宿就是顶部横条或左右竖条。
 * 取中心到三条边的距离，谁小贴谁 —— 左上角附近由实际距离决定，不做额外偏好。
 */
function zoneOf(rect, wa) {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dTop = cy - wa.y;
  const dLeft = cx - wa.x;
  const dRight = wa.x + wa.width - cx;
  if (dTop <= dLeft && dTop <= dRight) return 'top';
  return dLeft <= dRight ? 'left' : 'right';
}

/** 收起态胶囊尺寸（横条 = 内容宽×栏高，竖条 = 条厚×条长）。 */
function pillSize(vertical, dims) {
  return vertical ? { width: dims.sideW, height: dims.runH } : { width: dims.barW, height: dims.barH };
}

/**
 * 以某个中心点摆放收起态胶囊（拖动中横↔竖就地变形用它）。
 * 以中心为基准而不是左上角：翻转朝向时胶囊在光标底下不会横漂一段。
 */
function pillRect(centerX, centerY, vertical, dims, wa) {
  const size = pillSize(vertical, dims);
  const p = clampPos(centerX - size.width / 2, centerY - size.height / 2, size.width, size.height, wa);
  return { x: p.x, y: p.y, width: size.width, height: size.height };
}

/**
 * 最终停靠矩形：
 *   top   → 顶部居中横条
 *   left  → 贴左边缘竖条，垂直居中
 *   right → 贴右边缘竖条，垂直居中
 */
function dockedRect(dock, wa, dims) {
  const vertical = isVertical(dock);
  const size = pillSize(vertical, dims);
  if (vertical) {
    const x = dock === 'right' ? wa.x + wa.width - MARGIN - size.width : wa.x + MARGIN;
    const y = Math.round(wa.y + (wa.height - size.height) / 2);
    return { x, y, width: size.width, height: size.height };
  }
  const x = Math.round(wa.x + (wa.width - size.width) / 2);
  return { x, y: wa.y + MARGIN, width: size.width, height: size.height };
}

/**
 * 从当前窗口矩形反推收起态胶囊矩形。
 *
 * 用途：按住展开着的大卡片直接拖 —— 先落回胶囊本身，拖的才是胶囊而不是整张卡片。
 * 竖排时竖条贴着展开窗口的某一条边（anchor 'left' → 条在窗口右侧），横排取中心。
 */
function barRectFrom(cur, vertical, anchor, dims, wa) {
  if (vertical) {
    const width = dims.sideW;
    const height = dims.runH;
    const x = anchor === 'left' ? cur.x + cur.width - width : cur.x;
    const y = cur.y + cur.height / 2 - height / 2;
    const p = clampPos(x, y, width, height, wa);
    return { x: p.x, y: p.y, width, height };
  }
  const width = Math.min(dims.barW, cur.width);
  const x = cur.x + cur.width / 2 - width / 2;
  const p = clampPos(x, cur.y, width, dims.barH, wa);
  return { x: p.x, y: p.y, width, height: dims.barH };
}

module.exports = {
  MARGIN,
  clampPos,
  isVertical,
  anchorOf,
  zoneOf,
  pillSize,
  pillRect,
  dockedRect,
  barRectFrom,
};
