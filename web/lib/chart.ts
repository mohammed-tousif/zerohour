/**
 * Minimal single-series time chart (SVG): 2px line, 10% area wash, hairline
 * grid, end-point label, crosshair + tooltip on hover/keyboard, table view.
 * Labels are set with textContent only.
 */

export interface Point {
  t: number; // epoch ms
  v: number | null;
}

export interface ChartOptions {
  /** Formats a value for ticks, tooltip and end label */
  format: (v: number) => string;
  /** Text for the table's value column */
  valueLabel: string;
  /** Show the shaded area under the line (magnitudes; off for rates) */
  area?: boolean;
  /** Minimum top of the y-axis (e.g. 1 for an error-rate chart) */
  minMax?: number;
}

const SVG = 'http://www.w3.org/2000/svg';

/** Clean y-axis ticks from 0 to a round number ≥ max (4 intervals). */
export function niceTicks(max: number, intervals = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / intervals;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

/** 950 → "950"; 12,300 → "12.3K"; 4,500,000 → "4.5M" */
export function compact(n: number): string {
  if (Math.abs(n) < 10_000) return Math.round(n).toLocaleString('en-IN');
  if (Math.abs(n) < 1_000_000) return `${(n / 1_000).toFixed(n < 100_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const hhmm = (t: number) =>
  new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, parent?: Element) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.append(node);
  return node;
}

export class TimeChart {
  private points: Point[] = [];
  private readonly tooltip = document.createElement('div');
  private svg?: SVGSVGElement;
  private focusIndex = -1;
  private tableOpen = false;
  private readonly table = document.createElement('div');

  constructor(
    private readonly host: HTMLElement,
    private readonly opts: ChartOptions,
    private readonly emptyText: string,
  ) {
    this.tooltip.className = 'tooltip';
    this.tooltip.hidden = true;
    this.table.className = 'table-wrap';
    this.table.hidden = true;
    host.tabIndex = 0;
    host.setAttribute('role', 'img');
    host.addEventListener('keydown', (e) => this.onKey(e));
    host.addEventListener('blur', () => this.hideHover());
    new ResizeObserver(() => this.render()).observe(host);
    host.after(this.table);
  }

  set(points: Point[]): void {
    this.points = points;
    this.render();
    if (this.tableOpen) this.renderTable();
  }

  toggleTable(): boolean {
    this.tableOpen = !this.tableOpen;
    this.table.hidden = !this.tableOpen;
    if (this.tableOpen) this.renderTable();
    return this.tableOpen;
  }

  private renderTable(): void {
    const t = document.createElement('table');
    t.className = 'data-table';
    const head = t.createTHead().insertRow();
    for (const h of ['Minute', this.opts.valueLabel]) head.append(Object.assign(document.createElement('th'), { textContent: h }));
    const body = t.createTBody();
    for (const p of [...this.points].reverse()) {
      if (p.v === null) continue;
      const row = body.insertRow();
      row.insertCell().textContent = hhmm(p.t);
      row.insertCell().textContent = this.opts.format(p.v);
    }
    if (!body.rows.length) body.insertRow().insertCell().textContent = 'No data yet';
    this.table.replaceChildren(t);
  }

  private geometry() {
    const w = Math.max(240, this.host.clientWidth);
    const h = Math.max(140, this.host.clientHeight);
    const pad = { l: 46, r: 56, t: 12, b: 24 };
    const values = this.points.map((p) => p.v ?? 0);
    const ticks = niceTicks(Math.max(this.opts.minMax ?? 0, ...values));
    const top = ticks[ticks.length - 1]!;
    const t0 = this.points[0]?.t ?? 0;
    const t1 = this.points[this.points.length - 1]?.t ?? 1;
    const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - v / top) * (h - pad.t - pad.b);
    return { w, h, pad, ticks, x, y };
  }

  private render(): void {
    this.host.replaceChildren();
    const hasData = this.points.some((p) => (p.v ?? 0) > 0);
    if (!this.points.length || !hasData) {
      this.host.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: this.emptyText }));
      this.host.setAttribute('aria-label', this.emptyText);
      return;
    }
    const { w, h, pad, ticks, x, y } = this.geometry();
    const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none' });
    this.svg = svg;

    for (const v of ticks) {
      el('line', { x1: pad.l, x2: w - pad.r, y1: y(v), y2: y(v), class: v === 0 ? 'baseline' : 'gridline' }, svg);
      el('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' }, svg).textContent = this.opts.format(v);
    }
    const first = this.points[0]!;
    const last = this.points[this.points.length - 1]!;
    const mid = this.points[Math.floor(this.points.length / 2)]!;
    for (const [p, anchor] of [[first, 'start'], [mid, 'middle'], [last, 'end']] as const) {
      el('text', { x: x(p.t), y: h - 6, 'text-anchor': anchor, class: 'axis' }, svg).textContent = hhmm(p.t);
    }

    const pts = this.points.map((p) => [x(p.t), y(p.v ?? 0)] as const);
    const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
    if (this.opts.area !== false) {
      el('path', { d: `${line}L${pts[pts.length - 1]![0]},${y(0)}L${pts[0]![0]},${y(0)}Z`, class: 'series-area' }, svg);
    }
    el('path', { d: line, class: 'series-line' }, svg);

    // Selective direct label: the latest value only.
    const [lx, ly] = pts[pts.length - 1]!;
    el('circle', { cx: lx, cy: ly, r: 4, class: 'end-dot' }, svg);
    el('text', { x: lx + 8, y: ly + 4, class: 'end-label' }, svg).textContent = this.opts.format(last.v ?? 0);

    const hit = el('rect', { x: pad.l, y: pad.t, width: w - pad.l - pad.r, height: h - pad.t - pad.b, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', (e) => {
      const r = this.host.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * w;
      let best = 0;
      pts.forEach(([cx], i) => {
        if (Math.abs(cx - px) < Math.abs(pts[best]![0] - px)) best = i;
      });
      this.showHover(best);
    });
    hit.addEventListener('pointerleave', () => this.hideHover());

    this.host.append(svg, this.tooltip);
    const peak = Math.max(...this.points.map((p) => p.v ?? 0));
    this.host.setAttribute('aria-label', `Latest ${this.opts.format(last.v ?? 0)}, peak ${this.opts.format(peak)} over the window. Use arrow keys for values.`);
    if (this.focusIndex >= 0) this.showHover(Math.min(this.focusIndex, this.points.length - 1));
  }

  private showHover(i: number): void {
    if (!this.svg) return;
    this.focusIndex = i;
    const { h, pad, x, y } = this.geometry();
    const p = this.points[i]!;
    this.svg.querySelectorAll('.crosshair, .hover-dot').forEach((n) => n.remove());
    const cx = x(p.t);
    el('line', { x1: cx, x2: cx, y1: pad.t, y2: h - pad.b, class: 'crosshair' }, this.svg);
    el('circle', { cx, cy: y(p.v ?? 0), r: 5, class: 'hover-dot' }, this.svg);
    const strong = document.createElement('strong');
    strong.textContent = p.v === null ? 'no data' : this.opts.format(p.v);
    const label = document.createElement('span');
    label.append(Object.assign(document.createElement('span'), { className: 'key' }), `${this.opts.valueLabel} · ${hhmm(p.t)}`);
    this.tooltip.replaceChildren(strong, label);
    const scale = this.host.clientWidth / Math.max(240, this.host.clientWidth);
    this.tooltip.style.left = `${Math.min(Math.max(cx * scale, 70), this.host.clientWidth - 70)}px`;
    this.tooltip.style.top = `${y(p.v ?? 0)}px`;
    this.tooltip.hidden = false;
  }

  private hideHover(): void {
    this.focusIndex = -1;
    this.tooltip.hidden = true;
    this.svg?.querySelectorAll('.crosshair, .hover-dot').forEach((n) => n.remove());
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.points.length) return;
    const last = this.points.length - 1;
    const map: Record<string, number> = {
      ArrowLeft: Math.max(0, (this.focusIndex < 0 ? last : this.focusIndex) - 1),
      ArrowRight: Math.min(last, (this.focusIndex < 0 ? last : this.focusIndex) + 1),
      Home: 0,
      End: last,
    };
    if (e.key === 'Escape') return this.hideHover();
    if (map[e.key] === undefined) return;
    e.preventDefault();
    this.showHover(map[e.key]!);
  }
}
