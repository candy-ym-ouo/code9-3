import { Router } from 'express';
import { z } from 'zod';
import {
  FUZZ_LEVEL_LABEL,
  MISS_REASON_LABEL,
  TAG_DOMAIN_LABEL,
  TIME_ANCHORS,
  TIME_ANCHOR_LABEL,
  WEATHER_PRESETS,
  createTagSchema,
  updateTagSchema,
} from '@flil/shared';
import { getDb, newId, nowIso } from '../db.js';
import { ah, ok } from '../http/respond.js';
import { authenticate, requireOwner } from '../http/middleware.js';
import { ctxOf } from '../http/context.js';
import { buildTagTree } from '../services/serialization.js';
import { createTag, listTags, mergeTags, suggestTags, updateTag } from '../services/tags.js';
import { errors } from '../http/errors.js';

export const libraryRouter = Router();

libraryRouter.use(authenticate());

libraryRouter.get(
  '/library',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const library = getDb()
      .prepare('SELECT id, name, tz, default_fuzz_level, created_at FROM library WHERE id = ?')
      .get(ctx.libraryId);
    const members = getDb()
      .prepare(
        `SELECT m.role, u.id, u.email, u.display_name FROM library_member m
         JOIN "user" u ON u.id = m.user_id WHERE m.library_id = ?`,
      )
      .all(ctx.libraryId);
    ok(res, { library, members });
  }),
);

libraryRouter.patch(
  '/library',
  ah(async (req, res) => {
    requireOwner(req);
    const ctx = ctxOf(req);
    const input = z
      .object({
        name: z.string().min(1).max(120).optional(),
        tz: z.string().max(64).optional(),
        defaultFuzzLevel: z
          .enum(['exact', 'g100', 'g500', 'g1k', 'neighborhood', 'district'])
          .optional(),
      })
      .parse(req.body);
    const db = getDb();
    if (input.name) db.prepare('UPDATE library SET name = ?, updated_at = ? WHERE id = ?').run(input.name, nowIso(), ctx.libraryId);
    if (input.tz) db.prepare('UPDATE library SET tz = ?, updated_at = ? WHERE id = ?').run(input.tz, nowIso(), ctx.libraryId);
    if (input.defaultFuzzLevel) {
      // 库级默认是"对外默认"，不允许设为精确级别（安全底线：强制降级并告知）
      const level =
        input.defaultFuzzLevel === 'exact' || input.defaultFuzzLevel === 'g100'
          ? 'g500'
          : input.defaultFuzzLevel;
      db.prepare('UPDATE library SET default_fuzz_level = ?, updated_at = ? WHERE id = ?').run(
        level,
        nowIso(),
        ctx.libraryId,
      );
      ok(res, { updated: true, defaultFuzzLevel: level, downgraded: level !== input.defaultFuzzLevel });
      return;
    }
    ok(res, { updated: true });
  }),
);

libraryRouter.post(
  '/library/members',
  ah(async (req, res) => {
    requireOwner(req);
    const ctx = ctxOf(req);
    const input = z.object({ email: z.string().email(), role: z.enum(['member']).default('member') }).parse(req.body);
    const db = getDb();
    const user = db.prepare('SELECT id FROM "user" WHERE email = ?').get(input.email) as { id: string } | undefined;
    if (!user) throw errors.notFound('该邮箱对应的用户（需先注册）');
    db.prepare(
      'INSERT INTO library_member (id, library_id, user_id, role, created_at) VALUES (?,?,?,?,?) ON CONFLICT (library_id, user_id) DO NOTHING',
    ).run(newId(), ctx.libraryId, user.id, input.role, nowIso());
    ok(res, { added: true }, 201);
  }),
);

libraryRouter.delete(
  '/library/members/:userId',
  ah(async (req, res) => {
    requireOwner(req);
    const ctx = ctxOf(req);
    const target = getDb()
      .prepare('SELECT role FROM library_member WHERE library_id = ? AND user_id = ?')
      .get(ctx.libraryId, req.params.userId) as { role: string } | undefined;
    if (!target) throw errors.notFound('成员');
    if (target.role === 'owner') throw errors.badRequest('不能移除所有者');
    getDb().prepare('DELETE FROM library_member WHERE library_id = ? AND user_id = ?').run(ctx.libraryId, req.params.userId);
    ok(res, { removed: true });
  }),
);

/** 元数据：前端下拉与文案的唯一来源（避免前后端口径漂移） */
libraryRouter.get(
  '/meta',
  ah(async (_req, res) => {
    ok(res, {
      tagDomains: Object.entries(TAG_DOMAIN_LABEL).map(([key, label]) => ({ key, label })),
      timeAnchors: TIME_ANCHORS.map((key) => ({ key, label: TIME_ANCHOR_LABEL[key] })),
      weatherPresets: WEATHER_PRESETS,
      fuzzLevels: Object.entries(FUZZ_LEVEL_LABEL).map(([key, label]) => ({ key, label })),
      missReasons: Object.entries(MISS_REASON_LABEL).map(([key, label]) => ({ key, label })),
    });
  }),
);

// ------------------------------------------------------------------ tags

libraryRouter.get(
  '/tags',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const includeDisabled = req.query.includeDisabled === 'true';
    ok(res, { items: buildTagTree(listTags(ctx.libraryId, includeDisabled)) });
  }),
);

libraryRouter.post(
  '/tags',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const input = createTagSchema.parse(req.body);
    const id = createTag({
      libraryId: ctx.libraryId,
      domain: input.domain,
      name: input.name,
      parentId: input.parentId ?? null,
    });
    ok(res, { id }, 201);
  }),
);

libraryRouter.patch(
  '/tags/:id',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    updateTag(req.params.id, ctx.libraryId, updateTagSchema.parse(req.body));
    ok(res, { updated: true });
  }),
);

libraryRouter.post(
  '/tags/:id/merge',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const { targetId } = z.object({ targetId: z.string().min(1) }).parse(req.body);
    const detail = mergeTags(req.params.id, targetId, ctx.libraryId);
    ok(res, { merged: true, ...detail });
  }),
);

libraryRouter.get(
  '/tags/suggest',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const tagIds = String(req.query.tagIds ?? '')
      .split(',')
      .filter(Boolean);
    const limit = Math.min(20, Number(req.query.limit ?? 8));
    ok(res, { items: suggestTags(ctx.libraryId, tagIds, limit) });
  }),
);
