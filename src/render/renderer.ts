import { Application, Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import type { CommandQueue } from '../commands';
import { isTextEditable } from '../ui/dom';
import type { EventBus } from '../events';
import {
  doorFromOutsideTile,
  validateAmenityPlace,
  validateRoomBuild,
  validateRoomExpand,
  validateRoomRect,
} from '../sim/build';
import { BALANCE } from '../sim/data/balance';
import { ROOM_DEFS, roomFailure, type RoomType } from '../sim/data/rooms';
import type { WallEdge } from '../sim/entities/room';
import { boundaryEdges } from '../sim/entities/room';
import type { Patient } from '../sim/entities/patient';
import { auraCoversTile, moodOf } from '../sim/formulas';
import { PATIENT_TILES_PER_TICK, STAFF_TILES_PER_TICK } from '../sim/systems/movement';
import { samePoint, type GridPoint, type Rect } from '../sim/types';
import type { Walker, World } from '../sim/world';
import { expandPrice, priceOf } from '../sim/formulas';
import { HintLine } from './hintLine';
import { ThoughtBubbles } from './thoughtBubbles';
import { depthKey, TILE_H, TILE_W, toScreen, toTile, type TilePoint } from './iso';
import { growExpandRect, growRect, minRectAt } from './placement';
import {
  CHARACTER_FRAMES,
  characterKey,
  facingFromStep,
  FEET_ANCHOR,
  generateCharacterTextures,
  generateTileTextures,
  hazardKey,
  IDLE_FACING,
  MESS_VARIANTS,
  messKey,
  PROP_RISE_PAD,
  propKey,
  shade,
  variantFor,
  type CharacterKind,
  type PropSlice,
  type TileTextures,
} from './sprites';
import { PROP_STYLE } from '../sim/data/rooms';

/** Continuous zoom bounds + default (was 3 discrete steps; pinch needs a range). */
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const DEFAULT_ZOOM = 1;
/** Multiplicative zoom per wheel-delta unit for pinch / ctrl+wheel (exp curve). */
const ZOOM_WHEEL_SENSITIVITY = 0.0015;
/** Px per wheel-delta unit when a browser reports line/page deltaMode (Firefox mouse wheel). */
const WHEEL_LINE_PX = 16;
const PAN_SPEED_PX_PER_SEC = 700; // dt-scaled so pan speed is refresh-rate independent

/** Jump-target pulse (owner ask 2026-07-18: "can it somehow glow or pulse
 *  to show the area"): a throbbing outline over the destination of every
 *  click-to-jump. Pure presentation — performance.now timing, the sim never
 *  sees it. Amber = the ghost-valid "look here" color already in the language. */
const PULSE_DURATION_MS = 1600;
const PULSE_THROBS = 3;
/** A person pulse runs longer than a place pulse — the player is being asked
 *  to FOLLOW a moving target, not glance at a fixed one. Same throb cadence
 *  (2x duration, 2x throbs) so it reads as the same affordance. */
const PULSE_PATIENT_DURATION_MS = 3200;
const PULSE_PATIENT_THROBS = 6;
/** The selection ring is deliberately dimmer and thinner than the pulse — it
 *  has to be readable for minutes without becoming visual noise in a crowd. */
const SELECTION_COLOR = 0xffe066;
const SELECTION_WIDTH = 1.5;
const SELECTION_ALPHA = 0.55;
/** The throb never fully blacks out mid-pulse (review NIT: a bare cosine hit
 *  alpha 0 three times per pulse — a quarter-second after the click the glow
 *  momentarily vanished). */
const PULSE_THROB_FLOOR = 0.3;
const PULSE_COLOR = 0xffe066;
const PULSE_GLOW_WIDTH = 8;
const PULSE_LINE_WIDTH = 2.5;
const PULSE_GLOW_ALPHA = 0.35;
const EDGE_SCROLL_MARGIN_PX = 24;
const MAX_DRAW_DT_SEC = 0.1;
const WALL_HEIGHT = 34;
/** Warm off-white wall base; per-edge light factor shades it for volume. */
const WALL_BASE = 0xe9e5dd;
/** Height of the lit top-cap rim and the floor-line baseboard band (screen px). */
const WALL_CAP = 5;
const WALL_BASEBOARD = 4;
/** Near walls stay translucent so actors inside the room aren't occluded. */
const WALL_NEAR_ALPHA = 0.55;
/** Depth bias: far walls behind their tile's occupants, near walls in front. */
const WALL_Z_FAR = -0.45;
const WALL_Z_NEAR = 0.45;
/** Sim ticks per walk-cycle frame (10 tps / 3 ≈ 3.3 fps step cadence). */
const WALK_FRAME_TICKS = 3;
/** Bubble height above the feet anchor. */
const BUBBLE_RISE = 46;
/** Mood emoji size. Named because THOUGHT_RISE is derived from it — the two
 *  bubbles share one patient's headroom and the relationship must not be
 *  restated in prose where it can drift (post-impl review MAJOR). */
const MOOD_EMOJI_SIZE = 16;
/**
 * In-world thought bubble styling (owner ask 2026-07-18).
 *
 * THOUGHT_RISE clears the mood emoji, which anchors at (0.5, 1) on
 * `y - BUBBLE_RISE` and so occupies `[-62, -46]`. The balloon is built to
 * extend NOTHING below its own anchor (tail tip at local y=0), which is what
 * makes this a real clearance rather than a zoom-dependent one:
 *
 * POST-IMPL REVIEW MAJOR — the first version put the tail and the rect's
 * bottom edge BELOW the anchor by `(PAD_Y + TAIL_H) * (1 / zoom)`. That is a
 * WORLD offset against SCREEN-space geometry, so the gap grew as the player
 * zoomed out: fine at 2x, overlapping the emoji at 1x, and covering it
 * completely at 0.5x — hiding the mood indicator exactly when the patient is
 * thinking. Raising THOUGHT_RISE could not fix it (over-lifts at 2x, still
 * under-clears at 0.5x); the geometry had to be re-based instead.
 */
const THOUGHT_RISE = BUBBLE_RISE + MOOD_EMOJI_SIZE + 6;
/** Explicit family: the mood bubble renders a glyph and can inherit Pixi's
 *  default, but a sentence must match the DOM UI stack (ui.css) so the same
 *  thought reads identically in the bubble and the 💭 log. */
const THOUGHT_FONT = 'Segoe UI, system-ui, sans-serif';
const THOUGHT_FONT_SIZE = 12;
const THOUGHT_WRAP_PX = 140;
const THOUGHT_TEXT_COLOR = 0x2b2b2b;
const THOUGHT_FILL = 0xfdfcf7;
const THOUGHT_FILL_ALPHA = 0.94;
const THOUGHT_STROKE = 0x8a8578;
const THOUGHT_STROKE_ALPHA = 0.8;
const THOUGHT_PAD_X = 8;
const THOUGHT_PAD_Y = 5;
const THOUGHT_RADIUS = 7;
const THOUGHT_TAIL_W = 9;
const THOUGHT_TAIL_H = 7;
/**
 * Broken-room floor treatment (Stage 3, §S3.7): pull `def.floorColor` toward
 * its own luminance (desaturate) then darken — unmistakably "out of service"
 * grey, with the room's hue still recognizable underneath. Render styling
 * only (like WALL_BASE), not a game number.
 */
const BROKEN_FLOOR_GREY_MIX = 0.65;
const BROKEN_FLOOR_DARKEN = 0.7;
function brokenFloorTint(color: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b; // Rec.601 luma
  const mix = (c: number): number =>
    Math.round((c + (lum - c) * BROKEN_FLOOR_GREY_MIX) * BROKEN_FLOOR_DARKEN);
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

import { AMENITY_DEFS, type AmenityId } from '../sim/data/amenities';

/** UI interaction mode — the build menu drives it; Esc/right-click cancel it. */
export type UiMode =
  | { kind: 'idle' }
  | { kind: 'build'; type: RoomType }
  /** Stage B: grow a built room — hover previews the superset, click buys. */
  | { kind: 'expand'; roomId: number }
  /** Amenities Stage 1: 1-tile roomless prop placement (Track R implements the ghost). */
  | { kind: 'placeAmenity'; amenity: AmenityId }
  | { kind: 'sell' };

/** Idle-click selection: patient beats staff beats amenity beats room (M3 +
 *  amenities Stage 1 — amenities have no entity id; the tile IS the identity). */
export type Selection =
  | { kind: 'patient'; id: number }
  | { kind: 'staff'; id: number }
  | { kind: 'amenity'; col: number; row: number }
  | { kind: 'room'; id: number };

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
  /** Flat ground decals (messes) — above floors, below the depth-sorted world
   *  (Stage 2 plan §S2.6: sortedLayer has no "actor band" to slot under). */
  private decalLayer = new Container();
  private sortedLayer = new Container();
  private ghost = new Graphics();
  /** drawGhost input signature — rebuild only on change (see drawGhost). */
  private lastGhostKey = '';
  /** Arbitrates the shared hint line: instructions / errors / live price
   *  (Stage 0 review MAJOR — the price must not clobber a rejection reason). */
  private hintLine = new HintLine((text) => this.onHint?.(text));
  private highlight!: Sprite;
  private textures!: TileTextures;
  private markers = new Map<string, Sprite>();
  private roomVisuals = new Map<number, (Sprite | Graphics)[]>();
  private patientSprites = new Map<number, Sprite>();
  private staffSprites = new Map<number, Sprite>();
  private bubbles = new Map<number, Text>();
  /**
   * In-world thought bubbles (owner ask 2026-07-18, bubbles-first 2026-07-19).
   * The lifetime/eviction decisions live in the pure class so they have tests;
   * this layer is placement only. Its own container sits ABOVE `sortedLayer`
   * so a bubble is never occluded by an actor one tile to the south-east — a
   * notification you cannot read is not a notification. Mirrors how
   * `pulseGfx`/`selectionGfx` deliberately live outside the depth sort.
   */
  private thoughtBubbles = new ThoughtBubbles();
  private thoughtLayer = new Container();
  private thoughtVisuals = new Map<number, { text: Text; balloon: Graphics }>();
  private characterTextures!: Map<string, Texture>;
  private overlay = new Graphics();
  /** Debug: tint unwalkable tiles (toggled from the debug panel). */
  showWalkOverlay = false;
  /** Idle-click selection — inspection panel, debug panel, and readout use it. */
  selected: Selection | null = null;
  private zoom = DEFAULT_ZOOM;
  private heldKeys = new Set<string>();
  private panning: { startX: number; startY: number; camX: number; camY: number } | null = null;
  private lastPointer: { x: number; y: number } | null = null;
  private lastDrawTime: number | null = null;
  private build: BuildState | null = null;
  private sellMode = false;
  /** Stage B expand mode: hover previews the superset rect; click buys. */
  private expand: { roomId: number; rect: Rect | null } | null = null;
  /** Amenities Stage 1: armed 1-tile roomless prop placement (§3.4). */
  private amenityMode: AmenityId | null = null;
  /** Roomless amenity prop sprites, keyed `${col},${row}` (the tile IS the identity). */
  private amenitySprites = new Map<string, Sprite>();
  /** Mess decal sprites, keyed `${col},${row}` — messes are one-per-tile. */
  private messSprites = new Map<string, Sprite>();
  /** Jump-target pulse: single slot (a new jump replaces the old glow). */
  private pulseGfx = new Graphics();
  /**
   * A quiet, non-throbbing ring under the SELECTED patient, redrawn every
   * frame at their live sprite position.
   *
   * The pulse alone does not satisfy "follow their path" (owner ask
   * 2026-07-19): it fades after PULSE_PATIENT_DURATION_MS, leaving the player
   * with an inspect card naming someone they can no longer pick out of a
   * crowd. Live-drive confirmed exactly that — the card stayed on the patient
   * while every in-world trace of her was gone. This is the sustained half:
   * the pulse says "here", this says "still here".
   */
  private selectionGfx = new Graphics();
  /**
   * Single slot; a new pulse replaces any active one.
   *
   * `patient` is NOT a rect captured at click time (owner ask 2026-07-19: "so
   * the user can follow their path"). A walking patient leaves a fixed rect
   * behind within a second or two, which is what the tile pulse did — and the
   * thought-log entry's own `col,row` is where the thought HAPPENED, staler
   * still. This kind re-reads the walker every frame.
   */
  private pulseTarget:
    | { kind: 'rect'; rect: Rect; startedAt: number }
    | { kind: 'patient'; patientId: number; startedAt: number }
    | null = null;

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

  /** Back-compat view of the selection (debug panel, HUD readout). */
  get selectedPatientId(): number | null {
    return this.selected?.kind === 'patient' ? this.selected.id : null;
  }

  /** Click-to-jump (M3): center the camera on a tile at the current zoom. */
  jumpTo(col: number, row: number): void {
    const { x, y } = toScreen(col, row);
    this.camera.position.set(
      window.innerWidth / 2 - x * this.camera.scale.x,
      window.innerHeight / 2 - y * this.camera.scale.y,
    );
  }

  /** Pulse a footprint outline at the jump destination (owner ask) —
   *  single slot, a new pulse replaces any active one. */
  pulseRect(rect: Rect): void {
    this.pulseTarget = { kind: 'rect', rect: { ...rect }, startedAt: performance.now() };
  }

  /** Tile-sized pulse — toasts and amenity rows. */
  pulseTile(col: number, row: number): void {
    this.pulseRect({ col, row, cols: 1, rows: 1 });
  }

  /**
   * Pulse a PERSON, tracking them as they walk (owner ask 2026-07-19).
   * Ends early and silently if they are discharged, die or leave mid-pulse —
   * a terminal event during a 2.5s pulse is ordinary, not exceptional.
   */
  pulsePatient(patientId: number): void {
    this.pulseTarget = { kind: 'patient', patientId, startedAt: performance.now() };
  }

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
    this.characterTextures = generateCharacterTextures(this.app.renderer);
    this.sortedLayer.sortableChildren = true;
    this.camera.addChild(this.groundLayer, this.roomFloorLayer, this.decalLayer, this.sortedLayer);
    this.app.stage.addChild(this.camera);

    this.buildGround();

    this.highlight = new Sprite(this.textures.highlight);
    this.highlight.visible = false;
    this.camera.addChild(
      this.overlay,
      this.highlight,
      this.ghost,
      this.selectionGfx,
      this.pulseGfx,
      this.thoughtLayer,
    );

    this.centerCamera();
    this.bindInput();

    this.events.on('debugMarkerToggled', ({ col, row, present }) =>
      this.setMarker(col, row, present),
    );
    this.events.on('roomBuilt', ({ roomId }) => this.drawRoom(roomId));
    // Stage B: an expanded room re-renders whole (floors/walls/props) — still
    // per-room-change, never per-frame (HANDOFF render invariant).
    this.events.on('roomChanged', ({ roomId }) => {
      this.removeRoom(roomId); // same teardown as a sale (review NIT: no dup)
      this.drawRoom(roomId);
    });
    this.events.on('roomSold', ({ roomId }) => {
      this.removeRoom(roomId);
      if (this.selected?.kind === 'room' && this.selected.id === roomId) this.selected = null;
    });
    // Roomless amenity props (Stage 1): per-change draw/remove, never per-frame.
    this.events.on('amenityPlaced', ({ col, row, kind }) => this.drawAmenity(col, row, kind));
    this.events.on('amenitySold', ({ col, row }) => this.removeAmenity(col, row));
    // Mess decals (Stage 2): ONE event for add and remove — re-sync the tile
    // from world.messes (the frozen messChanged contract). Per-change only.
    this.events.on('messChanged', ({ col, row }) => this.syncMess(col, row));
    // Thought bubbles: a SIM-driven transient, so the renderer subscribes
    // directly (the messChanged/roomBuilt shape) rather than being driven from
    // main.ts like the jump pulse — that one is a USER action and belongs
    // beside the click handler. The thought log subscribes independently;
    // EventBus is plain fan-out and the two share no state.
    // `col,row` on the payload is deliberately IGNORED: it is where the thought
    // HAPPENED and goes stale within seconds (thoughtLog.ts:12-18). A bubble
    // must follow the walker, so it is keyed by patientId and reads the live
    // sprite position every frame.
    this.events.on('patientThought', ({ patientId, text }) => {
      this.thoughtBubbles.add(patientId, text, performance.now());
    });

    // Rooms that existed before the renderer (new-game start state).
    for (const roomId of this.world.rooms.keys()) this.drawRoom(roomId);
    // Amenities that existed before the renderer (the ?load= full-reload path
    // builds the world from the save BEFORE init — mirror the rooms loop).
    for (const amenity of this.world.amenities.values()) {
      this.drawAmenity(amenity.tile.col, amenity.tile.row, amenity.kind);
    }
    // Messes that existed before the renderer (same ?load= path — same mirror).
    for (const mess of this.world.messes.values()) {
      this.syncMess(mess.tile.col, mess.tile.row);
    }
  }

  // ---------------------------------------------------------------- mode API

  get mode(): UiMode {
    if (this.build) return { kind: 'build', type: this.build.type };
    if (this.expand) return { kind: 'expand', roomId: this.expand.roomId };
    if (this.amenityMode) return { kind: 'placeAmenity', amenity: this.amenityMode };
    if (this.sellMode) return { kind: 'sell' };
    return { kind: 'idle' };
  }

  setMode(mode: UiMode): void {
    this.build = null;
    this.sellMode = false;
    this.expand = null;
    this.amenityMode = null;
    if (mode.kind === 'build') {
      this.build = { type: mode.type, phase: 'drag', anchor: null, rect: null };
      this.hintLine.instruction(
        `Click to place the ${ROOM_DEFS[mode.type].label} — hold and drag to grow it`,
      );
    } else if (mode.kind === 'expand') {
      const room = this.world.rooms.get(mode.roomId);
      if (room) {
        this.expand = { roomId: mode.roomId, rect: null };
        this.hintLine.instruction(
          `Move outside the ${ROOM_DEFS[room.type].label} to grow it toward the cursor — click to buy`,
        );
      }
      // Room sold out from under the button: fall through as idle — the
      // onModeChanged notify below still fires (review NIT: an early return
      // skipped it, desyncing the toolbar mirror).
    } else if (mode.kind === 'placeAmenity') {
      this.amenityMode = mode.amenity;
      const def = AMENITY_DEFS[mode.amenity];
      // Same style the per-hover price line re-emits — the ghost geometry key
      // takes over as soon as the pointer is on the map.
      this.hintLine.instruction(
        `${def.label} — $${def.cost.toLocaleString('en-US')} · click to place`,
      );
    } else if (mode.kind === 'sell') {
      this.sellMode = true;
      this.hintLine.instruction(
        `Click a room to sell it (${BALANCE.economy.roomSellbackRatio * 100}% refund)`,
      );
    } else {
      this.hintLine.instruction('');
    }
    this.onModeChanged?.(this.mode);
  }

  private cancelMode(): void {
    // Esc peels one layer at a time: build/sell mode first, then the selection
    // (which closes the inspect panel) — RCT muscle memory (M4 polish).
    if (this.build || this.sellMode || this.expand || this.amenityMode) {
      this.setMode({ kind: 'idle' });
    } else {
      this.selected = null;
    }
  }

  /**
   * Idle-mode pick: patient beats staff beats amenity beats room (frozen §1.12
   * priority). ONE implementation for both the click handler and the hover
   * cursor (audit #10) — the cursor must never promise a click that resolves
   * differently.
   */
  private pickAt(tile: TilePoint): Selection | null {
    for (const patient of this.world.patients.values()) {
      if (samePoint(patient.at, tile) || (patient.next && samePoint(patient.next, tile))) {
        return { kind: 'patient', id: patient.id };
      }
    }
    for (const member of this.world.staff.values()) {
      if (samePoint(member.at, tile) || (member.next && samePoint(member.next, tile))) {
        return { kind: 'staff', id: member.id };
      }
    }
    if (this.world.amenityAt(tile.col, tile.row)) {
      return { kind: 'amenity', col: tile.col, row: tile.row };
    }
    const room = this.world.roomAt(tile);
    return room ? { kind: 'room', id: room.id } : null;
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
    // Broken room (Stage 3, §S3.7): grey the floors; the hazard decal below
    // marks the fault. `roomChanged` fires on breakdown AND repair completion,
    // so the existing removeRoom+drawRoom wiring redraws both transitions —
    // no new event subscription.
    const broken = room.brokenSince !== null;
    const floorTint = broken ? brokenFloorTint(def.floorColor) : def.floorColor;

    for (let col = room.rect.col; col < room.rect.col + room.rect.cols; col++) {
      for (let row = room.rect.row; row < room.rect.row + room.rect.rows; row++) {
        const floor = new Sprite(this.textures.plain);
        floor.tint = floorTint;
        floor.alpha = 0.92;
        const { x, y } = toScreen(col, row);
        floor.position.set(x - TILE_W / 2, y);
        this.roomFloorLayer.addChild(floor);
        visuals.push(floor);

        const tile = this.world.tileAt(col, row)!;
        if (tile.object) {
          // Strip props slice by RUN OFFSET, not neighbor presence (Stage A
          // review): density can lay two bed strips end-to-end in one room —
          // a 4-tile run — where the old east/west-neighbor check drew two
          // head-ends and no foot. Walking west to the run's start and taking
          // `offset % stripLen` recovers the true per-strip slice (strips are
          // placed atomically, so a same-object same-room run is always whole
          // strips — see slotOrigins' matching consumption). The roomId guard
          // still splits identical props across a shared wall (M1 review M-4).
          let slice: PropSlice = 'single';
          const stripLen = PROP_STYLE[tile.object].tiles;
          if (stripLen > 1) {
            let offset = 0;
            for (let west = col - 1; ; west--) {
              const t = this.world.tileAt(west, row);
              if (t?.object !== tile.object || t.roomId !== tile.roomId) break;
              offset += 1;
            }
            slice = offset % stripLen === 0 ? 'west' : 'east';
          }
          const sprite = new Sprite(this.textures.props.get(propKey(tile.object, slice))!);
          sprite.position.set(x - TILE_W / 2, y - PROP_RISE_PAD);
          sprite.zIndex = depthKey(col, row);
          this.sortedLayer.addChild(sprite);
          visuals.push(sprite);
        }
      }
    }

    // Hazard decal at the repair job's anchor tile (Stage 3, §S3.7). Parented
    // in decalLayer (flat: above floors, below the depth-sorted world) but
    // registered in THIS room's visuals[] so removeRoom destroys it with the
    // room — NEVER keyed in messSprites, which syncMess owns (pre-impl
    // MINOR 7: a decal in decalLayer but not in visuals leaks one sprite per
    // redraw/sell).
    if (broken) {
      const failure = roomFailure(room.type)!; // broken ⇒ a failure def exists
      // breakRoom mints the repair job BEFORE emitting roomChanged (frozen
      // order), so the rect-origin fallback is defensive, not a real path.
      let anchor: GridPoint = { col: room.rect.col, row: room.rect.row };
      for (const job of this.world.jobs.values()) {
        if (job.kind === 'repair' && job.roomId === room.id) {
          anchor = job.tile;
          break;
        }
      }
      const sprite = new Sprite(this.textures.hazards.get(hazardKey(failure.kind))!);
      const { x, y } = toScreen(anchor.col, anchor.row);
      // The anchor is usually the machine's own (non-walkable prop) tile —
      // spill the decal toward the tile's FRONT edge so it peeks out at the
      // prop's base instead of hiding behind it (the syncMess convention,
      // Stage-2 live-drive MINORs 1–2).
      const propSpill = this.world.tileAt(anchor.col, anchor.row)?.object ? TILE_H * 0.4 : 0;
      // Mirror bit hashes the ANCHOR tile coords (never rng) — the same
      // broken room redraws identically across re-syncs and reloads.
      const hash = ((Math.imul(anchor.col, 73856093) ^ Math.imul(anchor.row, 19349663)) >>> 0) >>> 4;
      if ((hash & 1) === 1) {
        sprite.scale.x = -1;
        sprite.position.set(x + TILE_W / 2, y + propSpill);
      } else {
        sprite.position.set(x - TILE_W / 2, y + propSpill);
      }
      this.decalLayer.addChild(sprite);
      visuals.push(sprite);
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

  /**
   * One boundary edge extruded upward into a soft-shaded wall: a lit/shadowed
   * outward face (light from the NW), a lit top-cap rim, a floor-line baseboard,
   * and a subtle top-to-bottom gradient — so walls read as volume, not slabs.
   * KEPT: far edges (N/W) opaque & sort behind the tile; near edges (S/E) stay
   * translucent & sort in front, so actors inside the room aren't occluded.
   */
  private wallGraphic(edge: WallEdge): Graphics {
    const { x, y } = toScreen(edge.inside.col, edge.inside.row);
    const dc = edge.outside.col - edge.inside.col;
    const dr = edge.outside.row - edge.inside.row;
    let p1: [number, number];
    let p2: [number, number];
    let far: boolean;
    let light: number; // per-face light factor: brightest facing NW, darkest facing SE
    if (dr === -1) {
      [p1, p2, far, light] = [[x, y], [x + TILE_W / 2, y + TILE_H / 2], true, 0.97]; // N
    } else if (dc === -1) {
      [p1, p2, far, light] = [[x, y], [x - TILE_W / 2, y + TILE_H / 2], true, 1.06]; // W
    } else if (dr === 1) {
      [p1, p2, far, light] = [[x - TILE_W / 2, y + TILE_H / 2], [x, y + TILE_H], false, 0.9]; // S
    } else {
      [p1, p2, far, light] = [[x, y + TILE_H], [x + TILE_W / 2, y + TILE_H / 2], false, 0.82]; // E
    }
    const alpha = far ? 1 : WALL_NEAR_ALPHA;
    const face = shade(WALL_BASE, light);
    const H = WALL_HEIGHT;
    const g = new Graphics();
    // Outward face.
    g.poly([p1[0], p1[1], p2[0], p2[1], p2[0], p2[1] - H, p1[0], p1[1] - H])
      .fill({ color: face, alpha });
    // Gentle gradient — brighter toward the top of the face.
    g.poly([p1[0], p1[1] - H * 0.45, p2[0], p2[1] - H * 0.45, p2[0], p2[1] - H, p1[0], p1[1] - H])
      .fill({ color: shade(face, 1.08), alpha: alpha * 0.5 });
    // Baseboard band at the floor line.
    g.poly([p1[0], p1[1] - WALL_BASEBOARD, p2[0], p2[1] - WALL_BASEBOARD, p2[0], p2[1], p1[0], p1[1]])
      .fill({ color: shade(face, 0.72), alpha });
    // Lit top-cap rim.
    g.poly([p1[0], p1[1] - H, p2[0], p2[1] - H, p2[0], p2[1] - H + WALL_CAP, p1[0], p1[1] - H + WALL_CAP])
      .fill({ color: shade(face, 1.16), alpha });
    // Subtle seam outline.
    g.poly([p1[0], p1[1], p2[0], p2[1], p2[0], p2[1] - H, p1[0], p1[1] - H])
      .stroke({ color: shade(face, 0.68), width: 1, alpha: alpha * 0.85 });
    g.zIndex = depthKey(edge.inside.col, edge.inside.row) + (far ? WALL_Z_FAR : WALL_Z_NEAR);
    return g;
  }

  private removeRoom(roomId: number): void {
    for (const visual of this.roomVisuals.get(roomId) ?? []) visual.destroy();
    this.roomVisuals.delete(roomId);
  }

  /**
   * Roomless amenity prop at a tile (Stage 1, §3.4): same texture path and
   * depth math as room props — the shared sorted layer keeps walkers in front
   * of / behind it correctly. Called per amenityPlaced/amenitySold change and
   * once at init for pre-existing amenities; never per-frame.
   */
  private drawAmenity(col: number, row: number, kind: AmenityId): void {
    const key = `${col},${row}`;
    this.amenitySprites.get(key)?.destroy(); // defensive: re-place over stale
    const sprite = new Sprite(this.textures.props.get(propKey(kind, 'single'))!);
    const { x, y } = toScreen(col, row);
    sprite.position.set(x - TILE_W / 2, y - PROP_RISE_PAD);
    sprite.zIndex = depthKey(col, row);
    this.sortedLayer.addChild(sprite);
    this.amenitySprites.set(key, sprite);
  }

  private removeAmenity(col: number, row: number): void {
    const key = `${col},${row}`;
    this.amenitySprites.get(key)?.destroy();
    this.amenitySprites.delete(key);
    if (this.selected?.kind === 'amenity' && this.selected.col === col && this.selected.row === row) {
      this.selected = null;
    }
  }

  /**
   * Re-sync one tile's mess decal from `world.messes` — the frozen
   * `messChanged` contract fires this for add AND remove (a `since` refresh
   * redraws the identical decal; harmless, still per-change). Decals are FLAT:
   * ground-tile placement math, no rise, and they live in `decalLayer` (above
   * floors, below the depth-sorted world) so actors always walk over them.
   * Variety (shape variant + mirror) hashes TILE COORDS — never the sim rng —
   * so a tile's mess looks the same on every re-sync and after a reload.
   */
  private syncMess(col: number, row: number): void {
    const key = `${col},${row}`;
    this.messSprites.get(key)?.destroy();
    this.messSprites.delete(key);
    const mess = this.world.messes.get(key);
    if (!mess) return;
    const hash = ((Math.imul(col, 73856093) ^ Math.imul(row, 19349663)) >>> 0) >>> 4;
    const sprite = new Sprite(this.textures.messes.get(messKey(mess.kind, hash % MESS_VARIANTS))!);
    const { x, y } = toScreen(col, row);
    // A decal on a PROP tile (a chair-tile vomit, an overflowing trashcan)
    // sits behind that prop's sprite in the depth-sorted layer and reads as
    // invisible (Stage-2 live-drive MINORs 1–2). Spill it toward the tile's
    // FRONT edge so the splat/scraps peek out at the prop's base — still in
    // decalLayer, still flat, still deterministic.
    const propSpill = this.world.tileAt(col, row)?.object ? TILE_H * 0.4 : 0;
    if ((hash & 1) === 1) {
      // Mirror around the tile's vertical center line — free extra variety;
      // the decal canvas spans the full tile, so flip + right-edge anchor
      // lands exactly where the unmirrored left-edge placement would.
      sprite.scale.x = -1;
      sprite.position.set(x + TILE_W / 2, y + propSpill);
    } else {
      sprite.position.set(x - TILE_W / 2, y + propSpill);
    }
    this.decalLayer.addChild(sprite);
    this.messSprites.set(key, sprite);
  }

  /** Mood bubble per GDD §10: 💢 impatient/AMA, 💀 critical, 💚 treated, ❓ lost. */
  private static bubbleFor(patient: Patient): string {
    if (patient.stage.kind === 'dead') return '';
    if (patient.stage.kind === 'leaving') {
      return patient.stage.reason === 'discharged' ? '💚' : '💢';
    }
    if (patient.lost) return '❓';
    const mood = moodOf(patient.health, patient.patience);
    if (mood === 'critical') return '💀';
    if (mood === 'impatient') return '💢';
    return '';
  }

  private makeCharacterSprite(kind: CharacterKind, entityId: number): Sprite {
    const sprite = new Sprite(
      this.characterTextures.get(characterKey(kind, variantFor(kind, entityId), IDLE_FACING, 0))!,
    );
    sprite.anchor.set(FEET_ANCHOR.x, FEET_ANCHOR.y);
    this.sortedLayer.addChild(sprite);
    return sprite;
  }

  private placeWalker(
    sprite: Sprite,
    walker: Walker,
    kind: CharacterKind,
    entityId: number,
    perTick: number,
    alpha: number,
  ): void {
    let fc = walker.at.col;
    let fr = walker.at.row;
    // Facing drives texture selection now (4 diagonal facings, §2.6); idle
    // actors rest toward the viewer. scale.x stays 1 — mirroring, if any, is
    // baked into the facing textures, not applied at draw time.
    let facing = IDLE_FACING;
    if (walker.next) {
      const frac = Math.min(walker.progress + alpha * perTick, 1);
      fc += (walker.next.col - walker.at.col) * frac;
      fr += (walker.next.row - walker.at.row) * frac;
      facing = facingFromStep(walker.next.col - walker.at.col, walker.next.row - walker.at.row);
    }
    // Deterministic stance offset (Flow rule 14): transient tile-sharing never
    // renders as one person. Hash the id, never the sim RNG.
    const jx = ((entityId * 37) % 9) - 4;
    const jy = ((entityId * 53) % 5) - 2;
    const { x, y } = toScreen(fc, fr);
    sprite.position.set(x + jx, y + TILE_H / 2 + 1 + jy);
    sprite.zIndex = depthKey(fc, fr);

    // Walk cycle while moving, idle frame while standing; per-entity phase
    // offset keeps a crowd from marching in lockstep.
    const frame = walker.next
      ? 1 +
        ((Math.floor(this.world.clock.tick / WALK_FRAME_TICKS) + entityId) %
          (CHARACTER_FRAMES - 1))
      : 0;
    sprite.texture = this.characterTextures.get(
      characterKey(kind, variantFor(kind, entityId), facing, frame),
    )!;
  }

  /** Poll-based actor sync: create/destroy sprites by diffing the world maps. */
  private updateActors(alpha: number): void {
    for (const [id, patient] of this.world.patients) {
      if (!this.patientSprites.has(id)) {
        this.patientSprites.set(id, this.makeCharacterSprite('patient', id));
      }
      const sprite = this.patientSprites.get(id)!;
      this.placeWalker(sprite, patient, 'patient', id, PATIENT_TILES_PER_TICK, alpha);
      sprite.alpha =
        patient.stage.kind === 'dead'
          ? Math.max(0, 1 - (this.world.clock.tick - patient.stage.since) / BALANCE.deathFadeTicks)
          : 1;

      const emoji = WorldRenderer.bubbleFor(patient);
      let bubble = this.bubbles.get(id);
      if (emoji && !bubble) {
        bubble = new Text({ text: emoji, style: { fontSize: MOOD_EMOJI_SIZE } });
        bubble.anchor.set(0.5, 1);
        this.sortedLayer.addChild(bubble);
        this.bubbles.set(id, bubble);
      }
      if (bubble) {
        if (!emoji) {
          bubble.destroy();
          this.bubbles.delete(id);
        } else {
          bubble.text = emoji;
          bubble.position.set(sprite.position.x, sprite.position.y - BUBBLE_RISE);
          bubble.zIndex = sprite.zIndex + 0.01;
        }
      }
    }
    for (const [id, sprite] of this.patientSprites) {
      if (!this.world.patients.has(id)) {
        sprite.destroy();
        this.patientSprites.delete(id);
        this.bubbles.get(id)?.destroy();
        this.bubbles.delete(id);
        // A thought bubble outlives its patient by up to BUBBLE_LIFETIME_MS,
        // and the last thing many patients think is emitted AS they leave
        // (`dischargePatient` -> emitThought). Drop the model entry here or the
        // visual is orphaned: `drawThoughtBubbles` reads `patientSprites` for
        // position and would silently skip it, leaking the Text/Graphics pair
        // until the next add for the same id.
        this.thoughtBubbles.remove(id);
        this.destroyThoughtVisual(id);
        if (this.selected?.kind === 'patient' && this.selected.id === id) this.selected = null;
      }
    }

    for (const [id, member] of this.world.staff) {
      if (!this.staffSprites.has(id)) {
        this.staffSprites.set(id, this.makeCharacterSprite(member.role, id));
      }
      this.placeWalker(this.staffSprites.get(id)!, member, member.role, id, STAFF_TILES_PER_TICK, alpha);
    }
    for (const [id, sprite] of this.staffSprites) {
      if (!this.world.staff.has(id)) {
        sprite.destroy();
        this.staffSprites.delete(id);
        if (this.selected?.kind === 'staff' && this.selected.id === id) this.selected = null;
      }
    }
  }

  // ------------------------------------------------------------------ camera

  private centerCamera(): void {
    const center = toScreen(this.world.cols / 2, this.world.rows / 2);
    this.camera.scale.set(this.zoom);
    this.camera.position.set(
      window.innerWidth / 2 - center.x * this.camera.scale.x,
      window.innerHeight / 2 - center.y * this.camera.scale.y,
    );
  }

  /** Set zoom (clamped to bounds) while keeping the given screen point fixed under it. */
  private zoomTo(targetZoom: number, clientX: number, clientY: number): void {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, targetZoom));
    if (z === this.zoom) return;
    const anchor = this.toWorldSpace(clientX, clientY);
    this.zoom = z;
    this.camera.scale.set(z);
    this.camera.position.set(clientX - anchor.x * z, clientY - anchor.y * z);
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


  // ------------------------------------------------------------------- input

  private handleLeftClick(tile: TilePoint): void {
    if (this.expand) {
      const room = this.world.rooms.get(this.expand.roomId);
      const rect = room ? growExpandRect(room.rect, tile) : null;
      if (!room || !rect) {
        this.setMode({ kind: 'idle' });
        return;
      }
      if (rect.cols * rect.rows === room.rect.cols * room.rect.rows) {
        this.hintLine.error('Move outside the room, then click to grow it there');
        return;
      }
      const check = validateRoomExpand(this.world, room.id, rect);
      if (!check.ok) {
        this.hintLine.error(check.reason);
        return;
      }
      this.commands.push({ type: 'expandRoom', roomId: room.id, rect });
      this.setMode({ kind: 'idle' });
      return;
    }
    if (this.build) {
      if (this.build.phase === 'drag') {
        // Anchor at the default size (hybrid placement): a plain click stamps
        // this rect; dragging grows it from here (never below a valid min).
        this.build.anchor = tile;
        this.build.rect = minRectAt(this.build.type, tile);
      } else if (this.build.rect) {
        const door = doorFromOutsideTile(this.build.rect, tile);
        if (!door) {
          this.hintLine.error('Click a corridor tile touching the room wall');
          return;
        }
        const check = validateRoomBuild(this.world, this.build.type, this.build.rect, door);
        if (!check.ok) {
          this.hintLine.error(check.reason);
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
    if (this.amenityMode) {
      // Same validator the ghost tint uses (SSOT rule 4) — the click can never
      // succeed where the ghost showed red.
      const check = validateAmenityPlace(this.world, this.amenityMode, tile);
      if (!check.ok) {
        // error(): survives the ghost's re-price until the geometry moves
        // (hintLine contract — same as the room-build rejection path).
        this.hintLine.error(check.reason);
        return;
      }
      this.commands.push({ type: 'placeAmenity', kind: this.amenityMode, col: tile.col, row: tile.row });
      // Mirror room build: one stamp exits the tool (re-arm from the menu).
      this.setMode({ kind: 'idle' });
      return;
    }
    if (this.sellMode) {
      // Stage 1 deliberately IGNORES amenity tiles here (plan §1.11 / NIT 14):
      // amenities sell via their inspect card only — 'No room there' stands.
      const room = this.world.roomAt(tile);
      if (room) this.commands.push({ type: 'sellRoom', roomId: room.id });
      else this.onHint?.('No room there');
      return;
    }
    // Idle mode: shared pick (audit #10) — patient beats staff beats room.
    this.selected = this.pickAt(tile);
  }

  private finishDrag(): void {
    if (!this.build || this.build.phase !== 'drag' || !this.build.anchor || !this.build.rect) {
      return;
    }
    const rect = this.build.rect;
    const check = validateRoomRect(this.world, this.build.type, rect);
    if (!check.ok) {
      // error(): the reason must survive the ghost's immediate re-seed +
      // re-price next frame (Stage 0 review MAJOR).
      this.hintLine.error(check.reason);
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
      this.hintLine.instruction('Click a corridor tile beside the room to place the door');
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
          // Grow from the anchor toward the cursor, clamped to a VALID minimum
          // in either orientation (placement.ts — orientation follows the
          // drag, so rotated footprints the sim accepts stay reachable).
          this.build.rect = growRect(this.build.type, this.build.anchor, tile);
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
        if (this.panning) return; // a middle-drag owns the camera; wheel-pan would be overwritten anyway
        // Normalize deltaMode: trackpads report pixels, but a Firefox mouse
        // wheel reports lines (≈±3) / pages — scale those up or it's dead.
        const unit = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? window.innerHeight : 1;
        const dx = e.deltaX * unit;
        const dy = e.deltaY * unit;
        // Browser/trackpad convention: a PINCH arrives as ctrl(/meta)+wheel →
        // continuous zoom anchored at the cursor. Everything else — a trackpad
        // two-finger scroll (dx/dy) or a mouse wheel — PANS both axes, so
        // vertical two-finger scroll finally moves the camera up/down.
        if (e.ctrlKey || e.metaKey) {
          this.zoomTo(this.zoom * Math.exp(-dy * ZOOM_WHEEL_SENSITIVITY), e.clientX, e.clientY);
        } else {
          this.camera.position.set(this.camera.position.x - dx, this.camera.position.y - dy);
        }
      },
      { passive: false },
    );

    window.addEventListener('keydown', (e) => {
      if (isTextEditable(e.target)) return;
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
    // Since hybrid placement the rect exists the whole time a tool is armed
    // (minutes, not just mid-drag) — rebuild the Graphics and re-run the
    // validators only when the picture's inputs change (build-UX review: the
    // draw() hot path must not gain per-frame work; mirrors lastOverlayKey).
    // The sim tick IS an input: validity reads live actors/cash, which change
    // per tick — so the color stays honest at ≤10 revalidations/s, not 60fps.
    const build = this.build;
    const expand = this.expand;
    const amenity = this.amenityMode;
    const rect = build?.rect ?? expand?.rect ?? null;
    // Amenity ghost inputs: the armed kind, the hovered tile, and the sim tick
    // (validity reads live actors/cash — ≤10 revalidations/s, same as rooms).
    const key = amenity
      ? `amenity:${amenity}:${this.world.clock.tick}:` +
        `${this.hoveredTile ? `${this.hoveredTile.col},${this.hoveredTile.row}` : 'off'}`
      : !build && !expand
        ? ''
        : `${build ? `${build.type}:${build.phase}` : `expand:${expand!.roomId}`}:` +
          `${this.world.clock.tick}:` +
          `${rect ? `${rect.col},${rect.row},${rect.cols},${rect.rows}` : 'none'}:` +
          `${build?.phase === 'door' && this.hoveredTile ? `${this.hoveredTile.col},${this.hoveredTile.row}` : '-'}`;
    if (key === this.lastGhostKey) return;
    this.lastGhostKey = key;

    this.ghost.clear();
    if (amenity) {
      if (!this.hoveredTile) return;
      const valid = validateAmenityPlace(this.world, amenity, this.hoveredTile).ok;
      const { x, y } = toScreen(this.hoveredTile.col, this.hoveredTile.row);
      this.ghost
        .poly([x, y, x + TILE_W / 2, y + TILE_H / 2, x, y + TILE_H, x - TILE_W / 2, y + TILE_H / 2])
        .fill({ color: valid ? 0x7fd77f : 0xe07f7f, alpha: 0.45 });
      return;
    }
    if (!rect) return;

    // Validity: a new build validates the rect; an expansion validates the
    // superset against the built room (same validators the click will use).
    const rectValid = build
      ? validateRoomRect(this.world, build.type, rect).ok
      : validateRoomExpand(this.world, expand!.roomId, rect).ok;
    const fill = rectValid ? 0x7fd77f : 0xe07f7f;
    for (let col = rect.col; col < rect.col + rect.cols; col++) {
      for (let row = rect.row; row < rect.row + rect.rows; row++) {
        const { x, y } = toScreen(col, row);
        this.ghost
          .poly([x, y, x + TILE_W / 2, y + TILE_H / 2, x, y + TILE_H, x - TILE_W / 2, y + TILE_H / 2])
          .fill({ color: fill, alpha: 0.45 });
      }
    }

    if (build?.phase === 'door' && this.hoveredTile) {
      const door = doorFromOutsideTile(rect, this.hoveredTile);
      if (door) {
        const valid = validateRoomBuild(this.world, build.type, rect, door).ok;
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
      // Hover affordance (M4 polish): crosshair while placing/selling,
      // pointer over anything clickable, default otherwise.
      const cursor =
        this.build || this.sellMode || this.expand || this.amenityMode
          ? 'crosshair'
          : this.hoveredTile && this.pickAt(this.hoveredTile) !== null
            ? 'pointer'
            : 'default';
      this.app.canvas.style.cursor = cursor;
    }

    // Hybrid placement (owner ruling 2026-07-18): before any drag anchors, the
    // ghost previews the room at its DEFAULT (minimum) size under the cursor —
    // a click stamps it; holding and dragging grows it (never below min). The
    // old flow anchored a 1×1 invalid red rect, which read as broken.
    if (this.build?.phase === 'drag' && !this.build.anchor) {
      this.build.rect = this.hoveredTile ? minRectAt(this.build.type, this.hoveredTile) : null;
    }
    // Live price readout (Stage 0, CAPACITY_PLAN §4.1): size costs money, so
    // the hint line tracks the ghost — "Exam Room 4×3 — $4,000 · click to
    // place, drag to grow". Emitted only when the string changes (per tile
    // crossed, not per frame).
    if (this.build?.phase === 'drag' && this.build.rect) {
      const rect = this.build.rect;
      const price = priceOf(this.build.type, rect);
      this.hintLine.price(
        `${ROOM_DEFS[this.build.type].label} ${rect.cols}×${rect.rows} — ` +
          `$${price.toLocaleString('en-US')} · click to place, drag to grow`,
        // Geometry key incl. POSITION — the text repeats across tiles at the
        // same size, and an error hold must release when the ghost moves.
        `${rect.col},${rect.row},${rect.cols},${rect.rows}`,
      );
    }
    // Amenity placement (Stage 1): the 1-tile ghost carries a fixed price, so
    // the line is constant text — still routed through price() with the TILE
    // as the geometry key, so a rejection reason holds until the ghost moves
    // (hintLine contract), then live pricing resumes.
    if (this.amenityMode && this.hoveredTile) {
      const def = AMENITY_DEFS[this.amenityMode];
      // Hover honesty (Stage-2 live-drive MINOR 3): the line shows the
      // rejection reason the CLICK would give, not a price on a tile the
      // validator refuses — hover and click must never disagree. Runs per
      // tile crossed (the geometry key), same cadence as the ghost tint.
      const check = validateAmenityPlace(this.world, this.amenityMode, this.hoveredTile);
      this.hintLine.price(
        check.ok
          ? `${def.label} — $${def.cost.toLocaleString('en-US')} · click to place`
          : `${def.label} — ${check.reason}`,
        `amenity:${this.hoveredTile.col},${this.hoveredTile.row}`,
      );
    }
    // Expand mode (Stage B): the preview is the bounding box of the room and
    // the cursor — a strict superset growing toward the hand. Cursor inside
    // the room = nothing to buy (preview collapses to the current rect).
    if (this.expand) {
      const room = this.world.rooms.get(this.expand.roomId);
      if (!room) {
        this.setMode({ kind: 'idle' }); // sold/vanished mid-mode
      } else {
        const preview = this.hoveredTile ? growExpandRect(room.rect, this.hoveredTile) : null;
        // No ghost while the cursor is INSIDE the room (nothing to buy) — a
        // red wash over the whole room read as "broken" in the live drive.
        const grows =
          preview !== null && preview.cols * preview.rows > room.rect.cols * room.rect.rows;
        const hadPreview = this.expand.rect !== null;
        this.expand.rect = grows ? preview : null;
        if (grows) {
          const rect = preview;
          const price = expandPrice(room.type, room.rect, rect);
          this.hintLine.price(
            `${ROOM_DEFS[room.type].label} ${room.rect.cols}×${room.rect.rows} → ` +
              `${rect.cols}×${rect.rows} — +$${price.toLocaleString('en-US')} · click to expand`,
            `expand:${rect.col},${rect.row},${rect.cols},${rect.rows}`,
          );
        } else if (hadPreview) {
          // Cursor re-entered the room: the last "+$X" would linger while
          // nothing is previewed (review NIT) — restore the instruction once.
          this.hintLine.instruction(
            `Move outside the ${ROOM_DEFS[room.type].label} to grow it toward the cursor — click to buy`,
          );
        }
      }
    }

    this.updateActors(alpha);
    this.drawGhost();
    this.drawOverlay();
    this.drawSelectionRing();
    this.drawPulse(now);
    this.drawThoughtBubbles(now);
  }

  /** Tear down one bubble's Pixi objects. Idempotent — the reap loop and the
   *  expiry path both call it and either may run first. */
  private destroyThoughtVisual(patientId: number): void {
    const visual = this.thoughtVisuals.get(patientId);
    if (!visual) return;
    visual.text.destroy();
    visual.balloon.destroy();
    this.thoughtVisuals.delete(patientId);
  }

  /**
   * In-world thought bubbles (owner ask 2026-07-18 — the RCT "read their
   * thoughts" moment; bubbles chosen over the card-history first on
   * 2026-07-19 because they are the LIVE surface).
   *
   * Drawn per frame from the pure model, which owns lifetime and eviction.
   * Runs after `updateActors`, so it READS the sprite position that was
   * already placed this frame rather than re-deriving the tween — the same
   * rule `drawSelectionRing`/`pulsePoints` follow, and for the same reason: two
   * copies of the interpolation would disagree on any edit.
   *
   * Allocation-free at rest: the size check below returns before `visible()`
   * can allocate. (Post-impl review MINOR: an earlier version claimed this
   * budget while unconditionally allocating an array, a spread and a Set every
   * frame — ~240 short-lived objects/second with nothing on screen. drawPulse's
   * `if (!this.pulseTarget) return` is the contract being matched here.)
   */
  private drawThoughtBubbles(now: number): void {
    if (this.thoughtBubbles.size === 0 && this.thoughtVisuals.size === 0) return;
    const visible = this.thoughtBubbles.visible(now);
    const alive = new Set<number>();

    for (const { patientId, text, alpha } of visible) {
      const sprite = this.patientSprites.get(patientId);
      // The patient left between the thought and this frame. The reap loop
      // will clear the model entry; skip drawing rather than guessing a spot.
      if (!sprite) continue;
      alive.add(patientId);

      let visual = this.thoughtVisuals.get(patientId);
      if (!visual) {
        // fontFamily is explicit: the one pre-existing in-world Text renders an
        // EMOJI and could inherit Pixi's default, but a full sentence cannot —
        // it must match the DOM UI's stack (ui.css) so the same thought reads
        // identically in the bubble and in the 💭 log.
        const textNode = new Text({
          text,
          style: {
            fontFamily: THOUGHT_FONT,
            fontSize: THOUGHT_FONT_SIZE,
            fill: THOUGHT_TEXT_COLOR,
            wordWrap: true,
            wordWrapWidth: THOUGHT_WRAP_PX,
            align: 'center',
          },
        });
        textNode.anchor.set(0.5, 1);
        const balloon = new Graphics();
        // Balloon first so the text draws over it — the layer is unsorted.
        this.thoughtLayer.addChild(balloon, textNode);
        visual = { text: textNode, balloon };
        this.thoughtVisuals.set(patientId, visual);
      } else if (visual.text.text !== text) {
        visual.text.text = text;
      }

      // Counter-scale so the text stays a constant SIZE ON SCREEN. Everything
      // in `camera` scales with zoom (0.5x-2x), which is fine for the mood
      // GLYPH but would render a 12px sentence at 6px when zoomed out —
      // illegible, and the handoff already tracks zoom legibility as a live
      // concern (the sparks decal reads too subtle at default zoom).
      const counter = 1 / this.zoom;
      visual.text.scale.set(counter);
      visual.balloon.scale.set(counter);

      const x = sprite.position.x;
      const y = sprite.position.y - THOUGHT_RISE;
      // A bubble over a corpse must fade WITH the corpse (review NIT): dead
      // patients dissolve over deathFadeTicks and `complication`/`discharged`
      // thoughts fire at exactly those moments, so a full-opacity balloon would
      // hang above a vanishing sprite.
      const faded = alpha * sprite.alpha;

      // The balloon is drawn, not a generated texture: it must fit variable
      // text, and a fixed texture cannot stretch cleanly. This is the
      // pulseGfx/selectionGfx precedent and needs no sprites.ts change.
      // Bounds come from the laid-out Text, so wrapping is already resolved.
      // GEOMETRY. Two bugs were fixed here, both invisible to unit tests
      // (render is untested by design) and both caught downstream — the first
      // by live-drive, the second by review:
      //
      //  1. The Text anchor is (0.5, 1), so text grows UPWARD from its
      //     position. An early version offset the rect two paddings too high
      //     and the last wrapped line hung outside the balloon.
      //  2. Nothing may extend BELOW the anchor. Local units are multiplied by
      //     `counter` (= 1/zoom), so any negative-side geometry becomes a
      //     zoom-dependent intrusion into the mood emoji's band — see the
      //     THOUGHT_RISE docblock. Tail tip sits at local y = 0.
      //
      // Everything is therefore built UPWARD from y = 0:
      //   tail   [-TAIL_H, 0]
      //   rect   [-TAIL_H - h, -TAIL_H]
      //   text   bottom at -(TAIL_H + PAD_Y), growing up by textH
      // Width/height are read back from the laid-out Text, so wrapping is
      // already resolved — Pixi measures synchronously on the bounds getter,
      // so this is valid on a bubble's very first frame.
      const textH = visual.text.height / counter;
      const w = visual.text.width / counter + THOUGHT_PAD_X * 2;
      const h = textH + THOUGHT_PAD_Y * 2;
      visual.text.position.set(x, y - (THOUGHT_TAIL_H + THOUGHT_PAD_Y) * counter);
      visual.text.alpha = faded;
      visual.balloon.position.set(x, y);
      visual.balloon.alpha = faded;
      visual.balloon
        .clear()
        // Tail first and STROKED IN ITS OWN RIGHT (review MINOR): Pixi v8's
        // `stroke()` applies to the immediately preceding path only, so a
        // single trailing stroke would outline the rect and draw a hard 1px
        // line straight across the tail's base, leaving an unoutlined nub
        // below it. Stroking here and filling the rect afterwards covers that
        // shared edge, so the silhouette reads as one shape.
        .poly([-THOUGHT_TAIL_W / 2, -THOUGHT_TAIL_H, THOUGHT_TAIL_W / 2, -THOUGHT_TAIL_H, 0, 0])
        .fill({ color: THOUGHT_FILL, alpha: THOUGHT_FILL_ALPHA })
        .stroke({ color: THOUGHT_STROKE, width: 1, alpha: THOUGHT_STROKE_ALPHA })
        .roundRect(-w / 2, -THOUGHT_TAIL_H - h, w, h, THOUGHT_RADIUS)
        .fill({ color: THOUGHT_FILL, alpha: THOUGHT_FILL_ALPHA })
        .stroke({ color: THOUGHT_STROKE, width: 1, alpha: THOUGHT_STROKE_ALPHA });
    }

    // Reap visuals whose model entry expired this frame.
    for (const id of [...this.thoughtVisuals.keys()]) {
      if (!alive.has(id)) this.destroyThoughtVisual(id);
    }
  }

  /**
   * The jump pulse: an iso outline throbbing over the destination footprint
   * — PULSE_THROBS cosine cycles fading out over PULSE_DURATION_MS. O(1)
   * and allocation-light: one small Graphics, rebuilt only while a pulse is
   * live (≤1.6s per jump), a bare null-check otherwise — the draw() hot
   * path's per-frame budget is untouched at rest.
   */
  private drawPulse(now: number): void {
    if (!this.pulseTarget) return;
    const patient = this.pulseTarget.kind === 'patient';
    const duration = patient ? PULSE_PATIENT_DURATION_MS : PULSE_DURATION_MS;
    const throbs = patient ? PULSE_PATIENT_THROBS : PULSE_THROBS;
    const t = (now - this.pulseTarget.startedAt) / duration;
    if (t >= 1) {
      this.pulseTarget = null;
      this.pulseGfx.clear();
      return;
    }

    const points = this.pulsePoints(this.pulseTarget);
    if (!points) {
      // The patient was discharged, died or left mid-pulse. End quietly —
      // over a multi-second follow-pulse that is ordinary, not exceptional.
      this.pulseTarget = null;
      this.pulseGfx.clear();
      return;
    }

    const wave = 0.5 + 0.5 * Math.cos(2 * Math.PI * throbs * t);
    const throb = PULSE_THROB_FLOOR + (1 - PULSE_THROB_FLOOR) * wave;
    const alpha = (1 - t) * throb;
    this.pulseGfx
      .clear()
      .poly(points)
      .stroke({ color: PULSE_COLOR, width: PULSE_GLOW_WIDTH, alpha: alpha * PULSE_GLOW_ALPHA })
      .poly(points)
      .stroke({ color: PULSE_COLOR, width: PULSE_LINE_WIDTH, alpha });
  }

  /**
   * The selected patient's standing ring. Cheap by construction: one poly when
   * a patient is selected, a `clear()` otherwise — the hot-path budget the art
   * pass guards is untouched (no per-tile work, no texture churn).
   */
  private drawSelectionRing(): void {
    const id = this.selectedPatientId;
    const sprite = id === null ? undefined : this.patientSprites.get(id);
    if (!sprite) {
      // Covers both "nothing selected" and "they were discharged/died/left" —
      // `selected` is cleared elsewhere on removal, but a stale id must never
      // leave a ring painted over empty floor.
      this.selectionGfx.clear();
      return;
    }
    const { x, y } = sprite.position;
    this.selectionGfx
      .clear()
      .poly([x, y - TILE_H / 2, x + TILE_W / 2, y, x, y + TILE_H / 2, x - TILE_W / 2, y])
      .stroke({ color: SELECTION_COLOR, width: SELECTION_WIDTH, alpha: SELECTION_ALPHA });
  }

  /** The outline for the active pulse, or null if its subject is gone. */
  private pulsePoints(target: NonNullable<typeof this.pulseTarget>): number[] | null {
    if (target.kind === 'patient') {
      // Read the SPRITE, not the walker: `updateActors` has already placed it
      // for this frame (draw() order), so the ring cannot drift from the body
      // it is ringing. Re-deriving the tween here would duplicate
      // `placeWalker`'s interpolation and the two would disagree on any edit.
      const sprite = this.patientSprites.get(target.patientId);
      if (!sprite) return null;
      const { x, y } = sprite.position;
      return [
        x, y - TILE_H / 2,
        x + TILE_W / 2, y,
        x, y + TILE_H / 2,
        x - TILE_W / 2, y,
      ];
    }
    const { rect } = target;
    const north = toScreen(rect.col, rect.row);
    const east = toScreen(rect.col + rect.cols - 1, rect.row);
    const south = toScreen(rect.col + rect.cols - 1, rect.row + rect.rows - 1);
    const west = toScreen(rect.col, rect.row + rect.rows - 1);
    return [
      north.x, north.y,
      east.x + TILE_W / 2, east.y + TILE_H / 2,
      south.x, south.y + TILE_H,
      west.x - TILE_W / 2, west.y + TILE_H / 2,
    ];
  }

  private tintTile(col: number, row: number, color: number, alpha: number): void {
    const { x, y } = toScreen(col, row);
    this.overlay
      .poly([x, y, x + TILE_W / 2, y + TILE_H / 2, x, y + TILE_H, x - TILE_W / 2, y + TILE_H / 2])
      .fill({ color, alpha });
  }

  /** Coverage overlay is live while placing an atrium or with one selected (GDD §9). */
  private auraOverlayActive(): boolean {
    if (this.build?.type === 'atrium') return true;
    if (this.selected?.kind !== 'room') return false;
    return this.world.rooms.get(this.selected.id)?.type === 'atrium';
  }

  /**
   * Overlay rebuild cache (perf DoD finding: the per-frame per-tile hasAura
   * queries + full Graphics rebuild cost ~2ms/frame at 40×40 — ~10× the rest
   * of the render pass). The aura overlay is rebuilt ONLY when this key moves:
   * `world.auraRevision` (bumped solely when the aura grid actually
   * recomputes) plus the overlay-relevant local state (mode on/off, atrium
   * build-ghost rect). Otherwise the existing Graphics is reused untouched.
   * The debug walk overlay stays uncached: walkability has no revision
   * counter, and it's a debug toggle, not the measured hot path.
   */
  private lastOverlayKey: string | null = null;

  private drawOverlay(): void {
    if (this.showWalkOverlay) {
      this.lastOverlayKey = null; // uncached debug path — always rebuilt
      this.overlay.clear();
      for (let col = 0; col < this.world.cols; col++) {
        for (let row = 0; row < this.world.rows; row++) {
          if (this.world.tileAt(col, row)!.walkable) continue;
          this.tintTile(col, row, 0xd94f4f, 0.4);
        }
      }
      return;
    }
    if (!this.auraOverlayActive()) {
      if (this.lastOverlayKey !== 'off') {
        this.overlay.clear();
        this.lastOverlayKey = 'off';
      }
      return;
    }

    // One refresh per frame BEFORE the revision compare: the signature check
    // is what detects same-tick staffing changes (movement can deliver a
    // greeter mid-tick — HANDOFF invariant), bumping auraRevision so this
    // very frame rebuilds instead of showing one stale frame.
    this.world.refreshAuras();

    // Ghost radius: potential coverage of the pending atrium rect (GDD §9
    // "while placing"). Since the hybrid-placement pass, `build.rect` is
    // ALWAYS set while the tool is armed and the pointer is on the map — the
    // hover preview IS a min-size rect at the cursor — so the old separate
    // hover fallback leg is gone. WHICH atrium is selected is deliberately not
    // in the key — the overlay draws coverage for ALL atriums, so the picture
    // only depends on the aura grid (auraRevision) and the preview geometry.
    const atriumBuild = this.build?.type === 'atrium' ? this.build : null;
    const previewRect = atriumBuild?.rect ?? null;
    /** Anchored = the player is committing a drag; pre-anchor hover is dimmed. */
    const anchored = atriumBuild?.anchor != null;
    // The preview leg makes the key pointer-dependent ONLY while the atrium
    // tool is armed (and even then it moves per tile crossed, not per frame);
    // every other state's key is pointer-independent, so the
    // no-per-frame-rebuild guarantee holds outside placement.
    let key = `aura:${this.world.auraRevision}`;
    if (previewRect) {
      key += `:${anchored ? 'drag' : 'hover'}:${previewRect.col},${previewRect.row},${previewRect.cols},${previewRect.rows}`;
    }
    // No preview (pointer off-map/over UI) draws the same picture as the
    // plain aura state, so the base key is correct — no extra rebuild leg.
    if (key === this.lastOverlayKey) return;
    this.lastOverlayKey = key;

    this.overlay.clear();
    const radius = BALANCE.wayfinding.guidanceAuraRadius;
    for (let col = 0; col < this.world.cols; col++) {
      for (let row = 0; row < this.world.rows; row++) {
        const p = { col, row };
        if (this.world.hasGuidanceAura(p)) {
          this.tintTile(col, row, 0x57bb6a, 0.32); // live guidance coverage
        } else if (this.world.hasComfortAura(p)) {
          this.tintTile(col, row, 0x57bb6a, 0.12); // unstaffed: dimmed potential
        } else if (previewRect && auraCoversTile(previewRect, p, radius)) {
          // SSOT (audit #3): the preview asks THE membership formula, so it
          // can never drift from the live coverage refreshAuras computes.
          // Anchored-drag ghost keeps its wash; the pre-anchor hover preview
          // is dimmed (same convention as the unstaffed comfort tint).
          this.tintTile(col, row, 0xffe066, anchored ? 0.18 : 0.12);
        }
      }
    }
  }
}
