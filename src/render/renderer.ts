import { Application, Container, Graphics, Sprite } from 'pixi.js';
import type { CommandQueue } from '../commands';
import type { EventBus } from '../events';
import { doorFromOutsideTile, validateRoomBuild, validateRoomRect } from '../sim/build';
import { BALANCE } from '../sim/data/balance';
import { ROOM_DEFS, type RoomType } from '../sim/data/rooms';
import type { WallEdge } from '../sim/entities/room';
import { boundaryEdges } from '../sim/entities/room';
import { PATIENT_TILES_PER_TICK } from '../sim/systems/movement';
import { samePoint, type GridPoint, type Rect } from '../sim/types';
import type { World } from '../sim/world';
import { depthKey, TILE_H, TILE_W, toScreen, toTile, type TilePoint } from './iso';
import { generateTileTextures, type TileTextures } from './sprites';

const ZOOM_STEPS = [0.5, 1, 2] as const;
const DEFAULT_ZOOM_INDEX = 1;
const PAN_SPEED_PX_PER_SEC = 700; // dt-scaled so pan speed is refresh-rate independent
const EDGE_SCROLL_MARGIN_PX = 24;
const MAX_DRAW_DT_SEC = 0.1;
const WALL_HEIGHT = 34;
/** Depth bias: far walls behind their tile's occupants, near walls in front. */
const WALL_Z_FAR = -0.45;
const WALL_Z_NEAR = 0.45;
/** Texture-crop offsets (see sprites.ts padding rects). */
const BED_OFFSET = { x: -TILE_W / 2, y: -12 };
const PERSON_OFFSET = { x: -8, y: -44 };

/** UI interaction mode — the build menu drives it; Esc/right-click cancel it. */
export type UiMode =
  | { kind: 'idle' }
  | { kind: 'build'; type: RoomType }
  | { kind: 'sell' };

interface BuildState {
  type: RoomType;
  phase: 'drag' | 'door';
  anchor: GridPoint | null;
  rect: Rect | null;
}

export class WorldRenderer {
  private app = new Application();
  private camera = new Container();
  private groundLayer = new Container();
  private roomFloorLayer = new Container();
  private sortedLayer = new Container();
  private ghost = new Graphics();
  private highlight!: Sprite;
  private textures!: TileTextures;
  private markers = new Map<string, Sprite>();
  private roomVisuals = new Map<number, (Sprite | Graphics)[]>();
  private patientSprites = new Map<number, Sprite>();
  private zoomIndex: number = DEFAULT_ZOOM_INDEX;
  private heldKeys = new Set<string>();
  private panning: { startX: number; startY: number; camX: number; camY: number } | null = null;
  private lastPointer: { x: number; y: number } | null = null;
  private lastDrawTime: number | null = null;
  private build: BuildState | null = null;
  private sellMode = false;

  /** Current hovered tile, if in bounds — HUD readout polls this. */
  hoveredTile: TilePoint | null = null;
  /** Build menu syncs its buttons off this. */
  onModeChanged: ((mode: UiMode) => void) | null = null;
  /** Short instruction / rejection line for the UI hint bar. */
  onHint: ((hint: string) => void) | null = null;

  constructor(
    private world: World,
    private commands: CommandQueue,
    private events: EventBus,
  ) {}

  async init(mount: HTMLElement): Promise<void> {
    await this.app.init({
      background: 0x9aa38f,
      resizeTo: window,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    mount.appendChild(this.app.canvas);

    this.textures = generateTileTextures(this.app.renderer);
    this.sortedLayer.sortableChildren = true;
    this.camera.addChild(this.groundLayer, this.roomFloorLayer, this.sortedLayer);
    this.app.stage.addChild(this.camera);

    this.buildGround();

    this.highlight = new Sprite(this.textures.highlight);
    this.highlight.visible = false;
    this.camera.addChild(this.highlight, this.ghost);

    this.centerCamera();
    this.bindInput();

    this.events.on('debugMarkerToggled', ({ col, row, present }) =>
      this.setMarker(col, row, present),
    );
    this.events.on('roomBuilt', ({ roomId }) => this.drawRoom(roomId));
    this.events.on('roomSold', ({ roomId }) => this.removeRoom(roomId));
    this.events.on('patientSpawned', ({ patientId }) => this.addPatient(patientId));
  }

  // ---------------------------------------------------------------- mode API

  get mode(): UiMode {
    if (this.build) return { kind: 'build', type: this.build.type };
    if (this.sellMode) return { kind: 'sell' };
    return { kind: 'idle' };
  }

  setMode(mode: UiMode): void {
    this.build = null;
    this.sellMode = false;
    if (mode.kind === 'build') {
      this.build = { type: mode.type, phase: 'drag', anchor: null, rect: null };
      this.onHint?.(`Drag to lay out the ${ROOM_DEFS[mode.type].label}`);
    } else if (mode.kind === 'sell') {
      this.sellMode = true;
      this.onHint?.(
        `Click a room to sell it (${BALANCE.economy.roomSellbackRatio * 100}% refund)`,
      );
    } else {
      this.onHint?.('');
    }
    this.onModeChanged?.(this.mode);
  }

  private cancelMode(): void {
    if (this.build || this.sellMode) this.setMode({ kind: 'idle' });
  }

  // ------------------------------------------------------------- world views

  private buildGround(): void {
    const entrance = BALANCE.map.entrance;
    for (let col = 0; col < this.world.cols; col++) {
      for (let row = 0; row < this.world.rows; row++) {
        const isEntrance = col === entrance.col && row === entrance.row;
        const texture = isEntrance
          ? this.textures.entrance
          : this.textures.ground[(col + row) % 2 === 0 ? 0 : 1];
        const sprite = new Sprite(texture);
        const { x, y } = toScreen(col, row);
        sprite.position.set(x - TILE_W / 2, y);
        this.groundLayer.addChild(sprite);
      }
    }
  }

  private setMarker(col: number, row: number, present: boolean): void {
    const key = `${col},${row}`;
    if (present && !this.markers.has(key)) {
      const sprite = new Sprite(this.textures.marker);
      const { x, y } = toScreen(col, row);
      sprite.position.set(x - TILE_W / 2, y);
      this.groundLayer.addChild(sprite);
      this.markers.set(key, sprite);
    } else if (!present) {
      this.markers.get(key)?.destroy();
      this.markers.delete(key);
    }
  }

  private drawRoom(roomId: number): void {
    const room = this.world.rooms.get(roomId);
    if (!room) return;
    const visuals: (Sprite | Graphics)[] = [];
    const def = ROOM_DEFS[room.type];

    for (let col = room.rect.col; col < room.rect.col + room.rect.cols; col++) {
      for (let row = room.rect.row; row < room.rect.row + room.rect.rows; row++) {
        const floor = new Sprite(this.textures.plain);
        floor.tint = def.floorColor;
        floor.alpha = 0.92;
        const { x, y } = toScreen(col, row);
        floor.position.set(x - TILE_W / 2, y);
        this.roomFloorLayer.addChild(floor);
        visuals.push(floor);

        const tile = this.world.tileAt(col, row)!;
        if (tile.object === 'bed') {
          // West slice = the bed tile whose east neighbor IN THE SAME ROOM is
          // also bed — adjacent rooms may both own beds (M1 review M-4).
          const east = this.world.tileAt(col + 1, row);
          const eastIsBed = east?.object === 'bed' && east.roomId === tile.roomId;
          const sprite = new Sprite(eastIsBed ? this.textures.bedWest : this.textures.bedEast);
          sprite.position.set(x + BED_OFFSET.x, y + BED_OFFSET.y);
          sprite.zIndex = depthKey(col, row);
          this.sortedLayer.addChild(sprite);
          visuals.push(sprite);
        }
      }
    }

    if (def.kind !== 'open') {
      for (const edge of boundaryEdges(room.rect)) {
        if (
          room.door &&
          samePoint(edge.inside, room.door.inside) &&
          samePoint(edge.outside, room.door.outside)
        ) {
          continue; // the door gap
        }
        const wall = this.wallGraphic(edge);
        this.sortedLayer.addChild(wall);
        visuals.push(wall);
      }
    }
    this.roomVisuals.set(roomId, visuals);
  }

  /** One boundary edge extruded upward; far edges sort behind the tile, near in front. */
  private wallGraphic(edge: WallEdge): Graphics {
    const { x, y } = toScreen(edge.inside.col, edge.inside.row);
    const dc = edge.outside.col - edge.inside.col;
    const dr = edge.outside.row - edge.inside.row;
    let p1: [number, number];
    let p2: [number, number];
    let far: boolean;
    if (dr === -1) {
      [p1, p2, far] = [[x, y], [x + TILE_W / 2, y + TILE_H / 2], true]; // N
    } else if (dc === -1) {
      [p1, p2, far] = [[x, y], [x - TILE_W / 2, y + TILE_H / 2], true]; // W
    } else if (dr === 1) {
      [p1, p2, far] = [[x - TILE_W / 2, y + TILE_H / 2], [x, y + TILE_H], false]; // S
    } else {
      [p1, p2, far] = [[x, y + TILE_H], [x + TILE_W / 2, y + TILE_H / 2], false]; // E
    }
    const g = new Graphics();
    g.poly([
      p1[0], p1[1],
      p2[0], p2[1],
      p2[0], p2[1] - WALL_HEIGHT,
      p1[0], p1[1] - WALL_HEIGHT,
    ])
      .fill({ color: far ? 0xe9e5dd : 0xcfc8bc, alpha: far ? 1 : 0.55 })
      .stroke({ color: 0xa89f90, width: 1 });
    g.zIndex = depthKey(edge.inside.col, edge.inside.row) + (far ? WALL_Z_FAR : WALL_Z_NEAR);
    return g;
  }

  private removeRoom(roomId: number): void {
    for (const visual of this.roomVisuals.get(roomId) ?? []) visual.destroy();
    this.roomVisuals.delete(roomId);
  }

  private addPatient(patientId: number): void {
    const sprite = new Sprite(this.textures.patient);
    this.sortedLayer.addChild(sprite);
    this.patientSprites.set(patientId, sprite);
  }

  private updatePatients(alpha: number): void {
    const perTick = PATIENT_TILES_PER_TICK;
    for (const [id, sprite] of this.patientSprites) {
      const patient = this.world.patients.get(id);
      if (!patient) {
        sprite.destroy();
        this.patientSprites.delete(id);
        continue;
      }
      let fc = patient.at.col;
      let fr = patient.at.row;
      if (patient.next) {
        const frac = Math.min(patient.progress + alpha * perTick, 1);
        fc += (patient.next.col - patient.at.col) * frac;
        fr += (patient.next.row - patient.at.row) * frac;
      }
      const { x, y } = toScreen(fc, fr);
      sprite.position.set(x + PERSON_OFFSET.x, y + TILE_H / 2 + PERSON_OFFSET.y);
      sprite.zIndex = depthKey(fc, fr);
    }
  }

  // ------------------------------------------------------------------ camera

  private centerCamera(): void {
    const center = toScreen(this.world.cols / 2, this.world.rows / 2);
    this.camera.scale.set(ZOOM_STEPS[this.zoomIndex]);
    this.camera.position.set(
      window.innerWidth / 2 - center.x * this.camera.scale.x,
      window.innerHeight / 2 - center.y * this.camera.scale.y,
    );
  }

  /** Canvas pixel → world-space point (undo camera transform). */
  private toWorldSpace(clientX: number, clientY: number): { x: number; y: number } {
    return {
      x: (clientX - this.camera.position.x) / this.camera.scale.x,
      y: (clientY - this.camera.position.y) / this.camera.scale.y,
    };
  }

  private tileFromClient(clientX: number, clientY: number): TilePoint | null {
    const w = this.toWorldSpace(clientX, clientY);
    // toTileFractional maps tile (c,r)'s diamond exactly onto the unit square
    // [c,c+1)×[r,r+1), so flooring with no offset IS exact picking — do not
    // "recenter" the query point (see test/iso.test.ts picking cases).
    const tile = toTile(w.x, w.y);
    return this.world.tileAt(tile.col, tile.row) ? tile : null;
  }

  private static onUi(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('[data-ui]') !== null;
  }

  /** Keyboard guard: only text entry may swallow keys — a focused HUD button must not. */
  private static isTextEditable(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLElement &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
    );
  }

  // ------------------------------------------------------------------- input

  private handleLeftClick(tile: TilePoint): void {
    if (this.build) {
      if (this.build.phase === 'drag') {
        this.build.anchor = tile;
        this.build.rect = { col: tile.col, row: tile.row, cols: 1, rows: 1 };
      } else if (this.build.rect) {
        const door = doorFromOutsideTile(this.build.rect, tile);
        if (!door) {
          this.onHint?.('Click a corridor tile touching the room wall');
          return;
        }
        const check = validateRoomBuild(this.world, this.build.type, this.build.rect, door);
        if (!check.ok) {
          this.onHint?.(check.reason);
          return;
        }
        this.commands.push({
          type: 'buildRoom',
          roomType: this.build.type,
          rect: this.build.rect,
          doorOutside: tile,
        });
        this.setMode({ kind: 'idle' });
      }
      return;
    }
    if (this.sellMode) {
      const room = this.world.roomAt(tile);
      if (room) this.commands.push({ type: 'sellRoom', roomId: room.id });
      else this.onHint?.('No room there');
      return;
    }
    this.commands.push({ type: 'debugWalkTo', col: tile.col, row: tile.row });
  }

  private finishDrag(): void {
    if (!this.build || this.build.phase !== 'drag' || !this.build.anchor || !this.build.rect) {
      return;
    }
    const rect = this.build.rect;
    const check = validateRoomRect(this.world, this.build.type, rect);
    if (!check.ok) {
      this.onHint?.(check.reason);
      this.build.anchor = null;
      this.build.rect = null;
      return;
    }
    if (ROOM_DEFS[this.build.type].kind === 'open') {
      this.commands.push({
        type: 'buildRoom',
        roomType: this.build.type,
        rect,
        doorOutside: null,
      });
      this.setMode({ kind: 'idle' });
    } else {
      this.build.phase = 'door';
      this.build.anchor = null;
      this.onHint?.('Click a corridor tile beside the room to place the door');
    }
  }

  private bindInput(): void {
    const canvas = this.app.canvas;

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointermove', (e) => {
      this.lastPointer = { x: e.clientX, y: e.clientY };
      if (this.panning) {
        this.camera.position.set(
          this.panning.camX + (e.clientX - this.panning.startX),
          this.panning.camY + (e.clientY - this.panning.startY),
        );
        return;
      }
      if (this.build?.phase === 'drag' && this.build.anchor) {
        const tile = this.tileFromClient(e.clientX, e.clientY);
        if (tile) {
          const a = this.build.anchor;
          this.build.rect = {
            col: Math.min(a.col, tile.col),
            row: Math.min(a.row, tile.row),
            cols: Math.abs(tile.col - a.col) + 1,
            rows: Math.abs(tile.row - a.row) + 1,
          };
        }
      }
    });

    canvas.addEventListener('pointerleave', () => {
      this.lastPointer = null;
      this.hoveredTile = null;
      this.highlight.visible = false;
    });

    canvas.addEventListener('pointerdown', (e) => {
      if (WorldRenderer.onUi(e.target)) return;
      if (e.button === 1) {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        this.panning = {
          startX: e.clientX,
          startY: e.clientY,
          camX: this.camera.position.x,
          camY: this.camera.position.y,
        };
      } else if (e.button === 0 && !this.panning) {
        const tile = this.tileFromClient(e.clientX, e.clientY);
        if (tile) this.handleLeftClick(tile);
        // Capture the build drag so releasing over UI or off-window still
        // delivers pointerup here (tech plan §2.5; M1 review M-1).
        if (this.build?.phase === 'drag' && this.build.anchor) {
          canvas.setPointerCapture(e.pointerId);
        }
      } else if (e.button === 2) {
        this.cancelMode();
      }
    });

    canvas.addEventListener('pointerup', (e) => {
      if (e.button === 1 && this.panning) {
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        this.panning = null;
      } else if (e.button === 0) {
        if (!this.panning && canvas.hasPointerCapture(e.pointerId)) {
          canvas.releasePointerCapture(e.pointerId);
        }
        this.finishDrag();
      }
    });
    canvas.addEventListener('pointercancel', (e) => {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      this.panning = null;
      if (this.build?.phase === 'drag') {
        this.build.anchor = null;
        this.build.rect = null;
      }
    });

    canvas.addEventListener(
      'wheel',
      (e) => {
        if (WorldRenderer.onUi(e.target)) return;
        e.preventDefault();
        this.lastPointer = { x: e.clientX, y: e.clientY };
        const next = this.zoomIndex + (e.deltaY < 0 ? 1 : -1);
        if (next < 0 || next >= ZOOM_STEPS.length) return;
        const anchor = this.toWorldSpace(e.clientX, e.clientY);
        this.zoomIndex = next;
        const scale = ZOOM_STEPS[this.zoomIndex]!;
        this.camera.scale.set(scale);
        this.camera.position.set(e.clientX - anchor.x * scale, e.clientY - anchor.y * scale);
      },
      { passive: false },
    );

    window.addEventListener('keydown', (e) => {
      if (WorldRenderer.isTextEditable(e.target)) return;
      if (e.key === 'Escape') {
        this.cancelMode();
        return;
      }
      this.heldKeys.add(e.key.toLowerCase());
    });
    window.addEventListener('keyup', (e) => this.heldKeys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.heldKeys.clear());
  }

  // -------------------------------------------------------------------- draw

  private drawGhost(): void {
    this.ghost.clear();
    if (!this.build) return;
    const rect = this.build.rect;
    if (!rect) return;

    const rectValid = validateRoomRect(this.world, this.build.type, rect).ok;
    const fill = rectValid ? 0x7fd77f : 0xe07f7f;
    for (let col = rect.col; col < rect.col + rect.cols; col++) {
      for (let row = rect.row; row < rect.row + rect.rows; row++) {
        const { x, y } = toScreen(col, row);
        this.ghost
          .poly([x, y, x + TILE_W / 2, y + TILE_H / 2, x, y + TILE_H, x - TILE_W / 2, y + TILE_H / 2])
          .fill({ color: fill, alpha: 0.45 });
      }
    }

    if (this.build.phase === 'door' && this.hoveredTile) {
      const door = doorFromOutsideTile(rect, this.hoveredTile);
      if (door) {
        const valid = validateRoomBuild(this.world, this.build.type, rect, door).ok;
        const { x, y } = toScreen(door.outside.col, door.outside.row);
        this.ghost
          .poly([x, y, x + TILE_W / 2, y + TILE_H / 2, x, y + TILE_H, x - TILE_W / 2, y + TILE_H / 2])
          .fill({ color: valid ? 0xffe066 : 0xe07f7f, alpha: 0.7 });
      }
    }
  }

  /** Called by the loop every frame. */
  draw(alpha: number): void {
    const now = performance.now();
    const dt =
      this.lastDrawTime === null ? 0 : Math.min((now - this.lastDrawTime) / 1000, MAX_DRAW_DT_SEC);
    this.lastDrawTime = now;

    if (!this.panning) {
      const pan = PAN_SPEED_PX_PER_SEC * dt;
      let dx = 0;
      let dy = 0;
      if (this.heldKeys.has('w') || this.heldKeys.has('arrowup')) dy += pan;
      if (this.heldKeys.has('s') || this.heldKeys.has('arrowdown')) dy -= pan;
      if (this.heldKeys.has('a') || this.heldKeys.has('arrowleft')) dx += pan;
      if (this.heldKeys.has('d') || this.heldKeys.has('arrowright')) dx -= pan;
      if (this.lastPointer) {
        if (this.lastPointer.x <= EDGE_SCROLL_MARGIN_PX) dx += pan;
        if (this.lastPointer.x >= window.innerWidth - EDGE_SCROLL_MARGIN_PX) dx -= pan;
        if (this.lastPointer.y <= EDGE_SCROLL_MARGIN_PX) dy += pan;
        if (this.lastPointer.y >= window.innerHeight - EDGE_SCROLL_MARGIN_PX) dy -= pan;
      }
      if (dx !== 0 || dy !== 0) {
        this.camera.position.set(this.camera.position.x + dx, this.camera.position.y + dy);
      }
    }

    if (this.lastPointer && !this.panning) {
      this.hoveredTile = this.tileFromClient(this.lastPointer.x, this.lastPointer.y);
      if (this.hoveredTile) {
        const { x, y } = toScreen(this.hoveredTile.col, this.hoveredTile.row);
        this.highlight.position.set(x - TILE_W / 2, y);
        this.highlight.visible = true;
      } else {
        this.highlight.visible = false;
      }
    }

    this.updatePatients(alpha);
    this.drawGhost();
  }
}
