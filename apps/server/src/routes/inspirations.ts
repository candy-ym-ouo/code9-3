import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import { z } from 'zod';
import {
  annotationSchema,
  createInspirationSchema,
  createPlaceSchema,
  createSpotSchema,
  updateInspirationSchema,
  updateSpotSchema,
  bulkTagSchema,
  expectedAzimuth,
  validateGeometry,
  type AssetRole,
} from '@flil/shared';
import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
import { ah, ok } from '../http/respond.js';
import { authenticate, currentUser, requireOwner } from '../http/middleware.js';
import { ctxOf } from '../http/context.js';
import { errors } from '../http/errors.js';
import {
  archiveInspiration,
  bulkTag,
  createInspiration,
  dropInspiration,
  mergeInspirations,
  requireInspiration,
  reindexFts,
  setSpot,
  syncStatus,
  touch,
} from '../services/inspirations.js';
import { toAssetDto, toAnnotationDto, toInspirationDto, toSpotDto } from '../services/serialization.js';
import type { SerializeContext } from '../services/serialization.js';
import { ingestAsset, type AssetRow } from '../services/assets.js';
import { clearFuzzCache, loadSpotRow } from '../services/fuzzing.js';
import { loadSpotGeom } from '../services/windowEngine.js';
import { azimuthAt, elevationAt, utcToZonedParts, zonedTimeToUtc } from '@flil/shared';
import { emitEvent } from '../services/events.js';

export const inspirationRouter = Router();
inspirationRouter.use(authenticate());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 20 },
});

// ------------------------------------------------------------ inspirations

inspirationRouter.get(
  '/inspirations',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const db = getDb();
    const where = ['i.library_id = ?', 'i.deleted_at IS NULL'];
    const args: (string | number)[] = [ctx.libraryId];

    const status = req.query.status as string | undefined;
    if (status) {
      const list = status.split(',').filter(Boolean);
      where.push(`i.status IN (${list.map(() => '?').join(',')})`);
      args.push(...list);
    }
    const tagIds = String(req.query.tagIds ?? '')
      .split(',')
      .filter(Boolean);
    if (tagIds.length) {
      where.push(
        `EXISTS (SELECT 1 FROM inspiration_tag WHERE inspiration_id = i.id AND tag_id IN (${tagIds
          .map(() => '?')
          .join(',')}))`,
      );
      args.push(...tagIds);
    }
    if (req.query.placeId) {
      where.push('s.place_id = ?');
      args.push(String(req.query.placeId));
    }
    const page = Math.max(1, Number(req.query.page ?? 1));
    const size = Math.min(100, Math.max(1, Number(req.query.size ?? 24)));

    const rows = db
      .prepare(
        `SELECT i.* FROM inspiration i
         LEFT JOIN spot s ON s.id = i.spot_id
         WHERE ${where.join(' AND ')}
         ORDER BY i.updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, size, (page - 1) * size) as Record<string, unknown>[];

    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM inspiration i LEFT JOIN spot s ON s.id = i.spot_id WHERE ${where.join(' AND ')}`,
        )
        .get(...args) as { n: number }
    ).n;

    ok(res, {
      items: rows.map((r) => toInspirationDto(r as never, ctx)),
      total,
      page,
      size,
    });
  }),
);

inspirationRouter.post(
  '/inspirations',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const input = createInspirationSchema.parse(req.body);
    const id = createInspiration({
      libraryId: ctx.libraryId,
      title: input.title,
      note: input.note ?? null,
      seasonTags: input.seasonTags,
    });
    ok(res, { id }, 201);
  }),
);

inspirationRouter.get(
  '/inspirations/:id',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = requireInspiration(req.params.id, ctx.libraryId);
    // 机位编辑场景下 owner 可以看到精确坐标（文档 13.3）
    const detailCtx = { ...ctx, includePrecise: ctx.role === 'owner' };
    ok(res, { item: toInspirationDto(row, detailCtx) });
  }),
);

inspirationRouter.patch(
  '/inspirations/:id',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = requireInspiration(req.params.id, ctx.libraryId);
    const input = updateInspirationSchema.parse(req.body);
    const db = getDb();
    const sets: string[] = [];
    const args: unknown[] = [];
    if (input.title !== undefined) {
      sets.push('title = ?');
      args.push(input.title);
    }
    if (input.note !== undefined) {
      sets.push('note = ?');
      args.push(input.note);
    }
    if (input.seasonTags !== undefined) {
      sets.push('season_tags = ?');
      args.push(toJson(input.seasonTags));
    }
    if (input.spotId !== undefined) {
      if (input.spotId !== null) {
        const spot = db.prepare('SELECT id FROM spot WHERE id = ? AND library_id = ?').get(input.spotId, ctx.libraryId);
        if (!spot) throw errors.notFound('机位');
      }
      sets.push('spot_id = ?');
      args.push(input.spotId);
    }
    if (sets.length) {
      db.prepare(`UPDATE inspiration SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(
        ...(args as never[]),
        nowIso(),
        row.id,
      );
      reindexFts(row.id);
    }
    if (input.status && input.status !== row.status) {
      if (input.status === 'archived') archiveInspiration(row.id, 'manual');
      else if (input.status === 'dropped') dropInspiration(row.id, 'manual');
      else
        db.prepare('UPDATE inspiration SET status = ?, updated_at = ? WHERE id = ?').run(
          input.status,
          nowIso(),
          row.id,
        );
    }
    syncStatus(row.id);
    if (input.spotId !== undefined) touch(row.id);
    ok(res, { item: toInspirationDto(requireInspiration(row.id, ctx.libraryId), ctx) });
  }),
);

/** 单独绑定/解绑机位（闭环必需动作） */
inspirationRouter.post(
  '/inspirations/:id/spot',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = requireInspiration(req.params.id, ctx.libraryId);
    const { spotId } = z.object({ spotId: z.string().min(1).nullable() }).parse(req.body);
    if (spotId) {
      const spot = getDb()
        .prepare('SELECT id FROM spot WHERE id = ? AND library_id = ?')
        .get(spotId, ctx.libraryId);
      if (!spot) throw errors.notFound('机位');
    }
    setSpot(row.id, spotId);
    ok(res, { spotId, status: syncStatus(row.id) });
  }),
);

inspirationRouter.post(
  '/inspirations/:id/archive',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = requireInspiration(req.params.id, ctx.libraryId);
    const { reason } = z.object({ reason: z.string().max(500).nullable().optional() }).parse(req.body ?? {});
    archiveInspiration(row.id, reason ?? null);
    ok(res, { status: 'archived' });
  }),
);

inspirationRouter.post(
  '/inspirations/:id/drop',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = requireInspiration(req.params.id, ctx.libraryId);
    const { reason } = z.object({ reason: z.string().min(1).max(500) }).parse(req.body);
    dropInspiration(row.id, reason);
    ok(res, { status: 'dropped' });
  }),
);

inspirationRouter.post(
  '/inspirations/merge',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const input = z
      .object({ keepId: z.string().min(1), mergeIds: z.array(z.string().min(1)).min(1), reason: z.string().max(200).optional() })
      .parse(req.body);
    requireInspiration(input.keepId, ctx.libraryId);
    for (const id of input.mergeIds) requireInspiration(id, ctx.libraryId);
    mergeInspirations(input.keepId, input.mergeIds, input.reason ?? 'merged');
    ok(res, { merged: input.mergeIds.length });
  }),
);

inspirationRouter.post(
  '/inspirations/bulk-tag',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const input = bulkTagSchema.parse(req.body);
    const { added, removed } = bulkTag({
      libraryId: ctx.libraryId,
      inspirationIds: input.ids,
      addTagIds: input.addTagIds,
      removeTagIds: input.removeTagIds,
    });
    ok(res, { added, removed });
  }),
);

// ----------------------------------------------------------------- assets

inspirationRouter.post(
  '/inspirations/:id/assets',
  upload.array('files', 20),
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = requireInspiration(req.params.id, ctx.libraryId);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw errors.badRequest('没有收到文件');
    const role = ((req.body?.role as AssetRole | undefined) ?? 'reference') as AssetRole;

    const spot = row.spot_id ? loadSpotGeom(row.spot_id) : null;
    const results = [];
    for (const file of files) {
      const mime = file.mimetype ?? '';
      if (!mime.startsWith('image/')) throw errors.badRequest(`只接受图片文件：${file.originalname}`);
      results.push(
        await ingestAsset({
          libraryId: ctx.libraryId,
          inspirationId: row.id,
          role,
          filename: file.originalname,
          buffer: file.buffer,
          spot: spot ? { lat: spot.lat, lng: spot.lng, tz: spot.tz } : null,
        }),
      );
    }
    touch(row.id);
    ok(res, { items: results }, 201);
  }),
);

function loadAsset(assetId: string, libraryId: string): AssetRow {
  const row = getDb().prepare('SELECT * FROM asset WHERE id = ?').get(assetId) as AssetRow | undefined;
  if (!row) throw errors.notFound('图片');
  if (row.library_id !== libraryId) throw errors.scopeDenied();
  return row;
}

inspirationRouter.get(
  '/assets/:id/file',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = loadAsset(req.params.id, ctx.libraryId);
    if (!fs.existsSync(row.file_path)) throw errors.notFound('图片文件');
    res.sendFile(row.file_path);
  }),
);

inspirationRouter.get(
  '/assets/:id/thumb',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = loadAsset(req.params.id, ctx.libraryId);
    const target = row.thumb_path && fs.existsSync(row.thumb_path) ? row.thumb_path : row.file_path;
    if (!fs.existsSync(target)) throw errors.notFound('图片文件');
    res.sendFile(target);
  }),
);

inspirationRouter.patch(
  '/assets/:id',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = loadAsset(req.params.id, ctx.libraryId);
    const input = z
      .object({
        role: z.enum(['reference', 'detail', 'panorama', 'result']).optional(),
        shotAt: z.string().datetime().nullable().optional(),
      })
      .parse(req.body);
    if (input.role) {
      getDb().prepare('UPDATE asset SET role = ?, updated_at = ? WHERE id = ?').run(input.role, nowIso(), row.id);
    }
    if (input.shotAt !== undefined) {
      getDb().prepare('UPDATE asset SET shot_at = ?, updated_at = ? WHERE id = ?').run(input.shotAt, nowIso(), row.id);
    }
    ok(res, { updated: true });
  }),
);

inspirationRouter.delete(
  '/assets/:id',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = loadAsset(req.params.id, ctx.libraryId);
    getDb().prepare('DELETE FROM asset WHERE id = ?').run(row.id);
    ok(res, { deleted: true });
  }),
);

/** 用拍摄时刻 + 机位坐标重算当时的太阳位置（把照片变成条件的关键一步） */
inspirationRouter.post(
  '/assets/:id/recompute-sun',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = loadAsset(req.params.id, ctx.libraryId);
    const inspiration = requireInspiration(row.inspiration_id, ctx.libraryId);
    if (!inspiration.spot_id || !row.shot_at) {
      throw errors.badRequest('缺少机位或拍摄时间，无法反算太阳位置');
    }
    const spot = loadSpotGeom(inspiration.spot_id);
    if (!spot) throw errors.badRequest('机位不存在');
    const exifLocal = new Date(row.shot_at);
    const parts = utcToZonedParts(exifLocal, 'UTC');
    const instant = zonedTimeToUtc(spot.tz, parts.year, parts.month, parts.day, parts.hour, parts.minute);
    const elevation = elevationAt(instant, spot.lat, spot.lng);
    const azimuth = azimuthAt(instant, spot.lat, spot.lng);
    getDb()
      .prepare('UPDATE asset SET sun_elevation = ?, sun_azimuth = ?, updated_at = ? WHERE id = ?')
      .run(elevation, azimuth, nowIso(), row.id);
    const lightBearing = ((azimuth - spot.camera_bearing) % 360 + 360) % 360;
    ok(res, {
      shotAt: row.shot_at,
      instant: instant.toISOString(),
      sunElevation: elevation,
      sunAzimuth: azimuth,
      suggestedLightBearing: lightBearing,
      suggestedExpectedAzimuth: expectedAzimuth(spot.camera_bearing, lightBearing),
    });
  }),
);

inspirationRouter.get(
  '/assets/:id/annotations',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = loadAsset(req.params.id, ctx.libraryId);
    const rows = getDb()
      .prepare('SELECT * FROM composition_note WHERE asset_id = ? ORDER BY created_at')
      .all(row.id) as Record<string, unknown>[];
    ok(res, { items: rows.map(toAnnotationDto) });
  }),
);

/** 构图标注为覆盖式提交；坐标必须在 [0,1] 内，越界直接拒绝（文档 11.5） */
inspirationRouter.put(
  '/assets/:id/annotations',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = loadAsset(req.params.id, ctx.libraryId);
    const input = z.object({ items: z.array(annotationSchema) }).parse(req.body);
    for (const item of input.items) {
      const check = validateGeometry(item.kind, item.geometry);
      if (!check.ok) throw errors.badRequest(`标注校验失败：${check.error}`);
    }
    const db = getDb();
    const ts = nowIso();
    const run = db.transaction(() => {
      db.prepare('DELETE FROM composition_note WHERE asset_id = ?').run(row.id);
      for (const item of input.items) {
        db.prepare(
          'INSERT INTO composition_note (id, library_id, asset_id, kind, geometry, label, created_at) VALUES (?,?,?,?,?,?,?)',
        ).run(newId(), ctx.libraryId, row.id, item.kind, toJson(item.geometry), item.label ?? null, ts);
      }
    });
    run();
    const rows = db.prepare('SELECT * FROM composition_note WHERE asset_id = ?').all(row.id) as Record<
      string,
      unknown
    >[];
    ok(res, { items: rows.map(toAnnotationDto) });
  }),
);

// --------------------------------------------------------- places & spots

inspirationRouter.get(
  '/places',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const rows = getDb()
      .prepare(
        `SELECT p.*,
           (SELECT COUNT(*) FROM spot s WHERE s.place_id = p.id) AS spot_count,
           (SELECT COUNT(*) FROM inspiration i JOIN spot s2 ON s2.id = i.spot_id
             WHERE s2.place_id = p.id AND i.deleted_at IS NULL) AS inspiration_count
         FROM place p WHERE p.library_id = ? ORDER BY p.updated_at DESC`,
      )
      .all(ctx.libraryId);
    ok(res, { items: rows });
  }),
);

inspirationRouter.post(
  '/places',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const input = createPlaceSchema.parse(req.body);
    const id = newId();
    const ts = nowIso();
    getDb()
      .prepare(
        'INSERT INTO place (id, library_id, name, city, district, address_text, category, centroid_lat, centroid_lng, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        ctx.libraryId,
        input.name,
        input.city ?? null,
        input.district ?? null,
        input.addressText ?? null,
        input.category ?? null,
        input.centroid?.lat ?? null,
        input.centroid?.lng ?? null,
        ts,
        ts,
      );
    ok(res, { id }, 201);
  }),
);

inspirationRouter.get(
  '/spots',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const rows = getDb()
      .prepare('SELECT * FROM spot WHERE library_id = ? ORDER BY updated_at DESC LIMIT 500')
      .all(ctx.libraryId) as Record<string, unknown>[];
    const items = rows.map((r) => {
      const found = loadSpotRow(r.id as string);
      if (!found) return null;
      return { ...toSpotDto(found.spot, found.place, ctx), placeName: found.place?.name ?? null };
    });
    ok(res, { items: items.filter(Boolean) });
  }),
);

inspirationRouter.get(
  '/spots/:id',
  ah(async (req, res) => {
    const ctx = ctxOf(req, { includePrecise: true });
    const found = loadSpotRow(req.params.id);
    if (!found) throw errors.notFound('机位');
    if (found.spot.library_id !== ctx.libraryId) throw errors.scopeDenied();
    ok(res, { item: toSpotDto(found.spot, found.place, ctx) });
  }),
);

inspirationRouter.post(
  '/spots',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const input = createSpotSchema.parse(req.body);
    const place = getDb().prepare('SELECT id FROM place WHERE id = ? AND library_id = ?').get(input.placeId, ctx.libraryId);
    if (!place) throw errors.notFound('地点');
    const id = newId();
    const ts = nowIso();
    getDb()
      .prepare(
        `INSERT INTO spot (id, library_id, place_id, lat, lng, camera_bearing, elevation_m, access_note,
           best_time_note, visibility, tz, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        ctx.libraryId,
        input.placeId,
        input.lat,
        input.lng,
        input.cameraBearing,
        input.elevationM ?? null,
        input.accessNote ?? null,
        input.bestTimeNote ?? null,
        input.visibility,
        input.tz,
        ts,
        ts,
      );
    ok(res, { id }, 201);
  }),
);

inspirationRouter.patch(
  '/spots/:id',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const found = loadSpotRow(req.params.id);
    if (!found) throw errors.notFound('机位');
    if (found.spot.library_id !== ctx.libraryId) throw errors.scopeDenied();
    const input = updateSpotSchema.parse(req.body);
    const map: Record<string, unknown> = {
      lat: input.lat,
      lng: input.lng,
      camera_bearing: input.cameraBearing,
      elevation_m: input.elevationM,
      access_note: input.accessNote,
      best_time_note: input.bestTimeNote,
      visibility: input.visibility,
      tz: input.tz,
    };
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [column, value] of Object.entries(map)) {
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        args.push(value);
      }
    }
    if (sets.length) {
      getDb()
        .prepare(`UPDATE spot SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...(args as never[]), nowIso(), found.spot.id);
      // 坐标或级别变化 → 模糊缓存失效
      clearFuzzCache(found.spot.id);
    }
    const updated = loadSpotRow(found.spot.id)!;
    ok(res, { item: toSpotDto(updated.spot, updated.place, ctxOf(req, { includePrecise: true })) });
  }),
);

inspirationRouter.post(
  '/spots/:id/set-visibility',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const found = loadSpotRow(req.params.id);
    if (!found) throw errors.notFound('机位');
    if (found.spot.library_id !== ctx.libraryId) throw errors.scopeDenied();
    const { visibility } = z.object({ visibility: z.enum(['private', 'fuzzy_shared']) }).parse(req.body);
    getDb().prepare('UPDATE spot SET visibility = ?, updated_at = ? WHERE id = ?').run(visibility, nowIso(), found.spot.id);
    ok(res, { visibility });
  }),
);

/** 模糊效果预览（owner 专用）：让隐私后果看得见（文档 13.6） */
inspirationRouter.get(
  '/spots/:id/fuzz-preview',
  ah(async (req, res) => {
    const ctx = ctxOf(req, { includePrecise: true });
    requireOwner(req);
    const found = loadSpotRow(req.params.id);
    if (!found) throw errors.notFound('机位');
    if (found.spot.library_id !== ctx.libraryId) throw errors.scopeDenied();
    const level = (String(req.query.level ?? ctx.defaultFuzzLevel) as SerializeContext['defaultFuzzLevel']) ?? 'g500';
    const preview = toSpotDto(found.spot, found.place, { ...ctx, defaultFuzzLevel: level, includePrecise: false });
    ok(res, {
      precise: { lat: found.spot.lat, lng: found.spot.lng },
      fuzz: preview.fuzz,
      distanceKmHint: level === 'exact' ? 0 : null,
    });
  }),
);

inspirationRouter.get(
  '/inspirations/:id/calibration',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = requireInspiration(req.params.id, ctx.libraryId);
    const { listCalibration } = await import('../services/calibration.js');
    ok(res, { items: listCalibration(row.id) });
  }),
);
