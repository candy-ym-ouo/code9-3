import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';

let app: Express;
let token = '';
let tmpDir = '';
const getDbAsync = async () => (await import('../src/db.js')).getDb;

function call(method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: unknown) {
  let req = request(app)[method](url);
  if (token) req = req.set('authorization', `Bearer ${token}`);
  if (body !== undefined) req = req.send(body as object);
  return req;
}

interface FlatTag {
  id: string;
  parentId: string | null;
  name: string;
  usageCount: number;
}

/** 递归拉平标签树（自定义标签可能有任意深度，不能只取两层） */
async function flatTags(includeDisabled = false): Promise<FlatTag[]> {
  const res = await call('get', `/api/tags${includeDisabled ? '?includeDisabled=true' : ''}`);
  const out: FlatTag[] = [];
  const walk = (nodes: Record<string, unknown>[]): void => {
    for (const n of nodes) {
      out.push({
        id: n.id as string,
        parentId: (n.parentId as string | null) ?? null,
        name: n.name as string,
        usageCount: n.usageCount as number,
      });
      if (Array.isArray(n.children)) walk(n.children as Record<string, unknown>[]);
    }
  };
  walk(res.body.items as Record<string, unknown>[]);
  return out;
}

/** 直接读 FTS 表的 tags 列（验证历史灵感是否同步最可靠的口径） */
async function ftsTagText(inspirationId: string): Promise<string> {
  const getDb = await getDbAsync();
  const row = getDb()
    .prepare('SELECT tags FROM inspiration_fts WHERE inspiration_id = ?')
    .get(inspirationId) as { tags: string } | undefined;
  return row?.tags ?? '';
}

async function bindingCount(tagId: string): Promise<number> {
  const getDb = await getDbAsync();
  return (getDb().prepare('SELECT COUNT(*) AS n FROM inspiration_tag WHERE tag_id = ?').get(tagId) as {
    n: number;
  }).n;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-tag-test-'));
  process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.THUMB_DIR = path.join(tmpDir, 'thumbs');
  process.env.SHARE_DIR = path.join(tmpDir, 'share');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
  process.env.JWT_SECRET = 'test-secret';
  process.env.WEATHER_PROVIDER = 'fixture';
  process.env.ENABLE_CLIMATE_BASELINE = 'false';

  const { createApp } = await import('../src/app.js');
  const { migrate } = await import('../src/db.js');
  migrate();
  app = createApp();

  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'owner@tag-test.local', password: 'password123', displayName: '标签测试者' });
  token = res.body.token;
});

afterAll(async () => {
  const { closeDb } = await import('../src/db.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function makeTag(name: string, domain = 'light', parentId?: string | null): Promise<string> {
  const res = await call('post', '/api/tags', { domain, name, parentId: parentId ?? null });
  expect(res.status, `建标签 ${name}: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.id as string;
}

async function makeInspiration(title: string): Promise<string> {
  const res = await call('post', '/api/inspirations', { title });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('T1 循环父子关系必须拒绝', () => {
  it('把标签挂到自己名下 → 409 TAG_CYCLE_PARENT', async () => {
    const a = await makeTag('循环甲');
    const res = await call('patch', `/api/tags/${a}`, { parentId: a });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TAG_CYCLE_PARENT');
  });

  it('把祖父挂到孙子名下（隔代环）→ 409，且被拒后关系保持原样', async () => {
    const root = await makeTag('循环祖父');
    const mid = await makeTag('循环父辈', 'light', root);
    const leaf = await makeTag('循环孙辈', 'light', mid);

    const res = await call('patch', `/api/tags/${root}`, { parentId: leaf });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TAG_CYCLE_PARENT');

    const flat = await flatTags();
    expect(flat.find((t) => t.id === mid)?.parentId).toBe(root);
    expect(flat.find((t) => t.id === leaf)?.parentId).toBe(mid);
  });

  it('正常改挂（挂到无关分支与挂到根级）允许', async () => {
    const a = await makeTag('正常分支A');
    const b = await makeTag('正常分支B');
    const child = await makeTag('正常子节点', 'light', a);

    const toB = await call('patch', `/api/tags/${child}`, { parentId: b });
    expect(toB.status).toBe(200);
    const toRoot = await call('patch', `/api/tags/${child}`, { parentId: null });
    expect(toRoot.status).toBe(200);
  });
});

describe('T2 重命名/合并同步历史灵感与画册规则', () => {
  it('改名后历史灵感的 FTS 索引同步，并可按新名检索到旧卡', async () => {
    const tagId = await makeTag('原名霓虹');
    const cardId = await makeInspiration('改名索引卡');
    await call('post', '/api/inspirations/bulk-tag', { ids: [cardId], addTagIds: [tagId] });

    expect(await ftsTagText(cardId)).toContain('原名霓虹');

    const renamed = await call('patch', `/api/tags/${tagId}`, { name: '新名霓虹' });
    expect(renamed.status).toBe(200);

    const text = await ftsTagText(cardId);
    expect(text).toContain('新名霓虹');
    expect(text).not.toContain('原名霓虹');

    const afterNew = await call('get', '/api/search?q=新名霓虹');
    expect(afterNew.body.total).toBeGreaterThan(0);
  });

  it('合并后绑定迁移去重，FTS 只剩目标标签名，usage_count 按真实绑定重算', async () => {
    const src = await makeTag('合并源光');
    const tgt = await makeTag('合并目标光');
    const onlySrc = await makeInspiration('只挂源标签');
    const both = await makeInspiration('源和目标都挂');

    await call('post', '/api/inspirations/bulk-tag', { ids: [onlySrc, both], addTagIds: [src] });
    await call('post', '/api/inspirations/bulk-tag', { ids: [both], addTagIds: [tgt] });

    const merge = await call('post', `/api/tags/${src}/merge`, { targetId: tgt });
    expect(merge.status).toBe(200);

    const flat = await flatTags(true);
    expect(flat.find((t) => t.id === src)).toBeUndefined();
    expect(flat.find((t) => t.id === tgt)?.usageCount).toBe(2);

    // 两张受影响卡的 FTS 都只剩目标标签名
    expect(await ftsTagText(onlySrc)).toContain('合并目标光');
    expect(await ftsTagText(onlySrc)).not.toContain('合并源光');
    expect(await ftsTagText(both)).toContain('合并目标光');
    expect(await ftsTagText(both)).not.toContain('合并源光');

    // 关系表：目标标签共 2 行，源标签 0 行，无重复
    expect(await bindingCount(tgt)).toBe(2);
    expect(await bindingCount(src)).toBe(0);
  });

  it('合并同步画册规则中的标签引用（替换+组内去重）并重算缺口', async () => {
    const src = await makeTag('规则源色', 'color');
    const tgt = await makeTag('规则目标色', 'color');
    const cardId = await makeInspiration('画册规则同步卡');
    await call('post', '/api/inspirations/bulk-tag', { ids: [cardId], addTagIds: [src] });

    const album = await call('post', '/api/albums', {
      title: '标签引用同步画册',
      rules: {
        requireTags: [{ tagIds: [src, tgt], min: 1, required: true }], // 合并后同组去重为 [tgt]
        totalMin: 1,
        autoMatch: { enabled: true, minTagHits: 1 },
      },
    });
    const albumId = album.body.id;

    // 卡必须在画册里，标签缺口才有计数对象
    const addItem = await call('post', `/api/albums/${albumId}/items`, { inspirationId: cardId });
    expect(addItem.status).toBe(201);

    // 合并前：卡只挂 src，规则组 [src,tgt] 已命中
    const gapsBefore = await call('get', `/api/albums/${albumId}/gaps`);
    const tagGapBefore = gapsBefore.body.items.find((g: { kind: string }) => g.kind === 'tag') as {
      status: string;
    };
    expect(tagGapBefore.status).toBe('filled');

    const merge = await call('post', `/api/tags/${src}/merge`, { targetId: tgt });
    expect(merge.status).toBe(200);

    const detail = await call('get', `/api/albums/${albumId}`);
    const groups = detail.body.rules.requireTags as { tagIds: string[] }[];
    expect(groups).toHaveLength(1);
    expect(groups[0].tagIds).toEqual([tgt]);

    // 缺口按替换后的规则重算：卡迁移到了 tgt，仍然闭合
    const tagGapAfter = detail.body.gaps.find((g: { kind: string }) => g.kind === 'tag') as {
      status: string;
    };
    expect(tagGapAfter.status).toBe('filled');
  });

  it('祖先并入子孙时子树改挂不产生循环（结构仍可用）', async () => {
    const ancestor = await makeTag('祖先标签');
    const parent = await makeTag('中间标签', 'light', ancestor);
    const child = await makeTag('后代标签', 'light', parent);

    // ancestor → parent → child；把 ancestor 并入 child
    const merge = await call('post', `/api/tags/${ancestor}/merge`, { targetId: child });
    expect(merge.status).toBe(200);

    const flat = await flatTags(true);
    // ancestor 已删除；parent 不能挂到 child 之下（那会形成环），应提到根级；child 仍挂 parent
    expect(flat.find((t) => t.id === ancestor)).toBeUndefined();
    expect(flat.find((t) => t.id === parent)?.parentId).toBeNull();
    expect(flat.find((t) => t.id === child)?.parentId).toBe(parent);
  });
});

describe('T3 并发批量打标不得产生重复关系', () => {
  it('同一请求内重复标签与重复卡片只产生一行绑定，usage_count 不漂移', async () => {
    const tagId = await makeTag('并发标签');
    const cardId = await makeInspiration('并发打标卡');

    const res = await call('post', '/api/inspirations/bulk-tag', {
      ids: [cardId, cardId, cardId],
      addTagIds: [tagId, tagId, tagId],
    });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);

    // 再来一发完全相同的请求（幂等）
    const again = await call('post', '/api/inspirations/bulk-tag', {
      ids: [cardId],
      addTagIds: [tagId],
    });
    expect(again.body.added).toBe(0);

    const flat = await flatTags();
    expect(flat.find((t) => t.id === tagId)?.usageCount).toBe(1);
    expect(await bindingCount(tagId)).toBe(1);
  });

  it('多个并发请求同时给同一卡打同一标签，只落一行', async () => {
    const tagId = await makeTag('真并发标签');
    const cardId = await makeInspiration('真并发卡');

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        call('post', '/api/inspirations/bulk-tag', { ids: [cardId], addTagIds: [tagId] }),
      ),
    );
    for (const r of results) expect(r.status).toBe(200);
    expect(results.reduce((sum, r) => sum + (r.body.added as number), 0)).toBe(1);

    const flat = await flatTags();
    expect(flat.find((t) => t.id === tagId)?.usageCount).toBe(1);
    expect(await bindingCount(tagId)).toBe(1);

    const detail = await call('get', `/api/inspirations/${cardId}`);
    expect((detail.body.item.tags as { id: string }[]).filter((t) => t.id === tagId)).toHaveLength(1);
  });

  it('跨库标签 ID 混入批量打标被拒；同一标签既加又删被拒', async () => {
    const tagId = await makeTag('本库标签');
    const cardId = await makeInspiration('越权卡');

    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'other@tag-test.local', password: 'password123', displayName: '别的库' });
    const otherToken = other.body.token as string;
    const fTag = (
      await request(app)
        .post('/api/tags')
        .set('authorization', `Bearer ${otherToken}`)
        .send({ domain: 'light', name: '外库标签' })
    ).body.id as string;
    const fCard = (
      await request(app)
        .post('/api/inspirations')
        .set('authorization', `Bearer ${otherToken}`)
        .send({ title: '外库卡' })
    ).body.id as string;

    // 用本库登录态拿外库 tagId 打本库的卡 → 拒绝
    const cross = await call('post', '/api/inspirations/bulk-tag', { ids: [cardId], addTagIds: [fTag] });
    expect([403, 404]).toContain(cross.status);

    // 外库拿本库 tagId 打外库卡 → 拒绝
    const cross2 = await request(app)
      .post('/api/inspirations/bulk-tag')
      .set('authorization', `Bearer ${otherToken}`)
      .send({ ids: [fCard], addTagIds: [tagId] });
    expect([403, 404]).toContain(cross2.status);

    // 同一标签既加又删 → 请求自相矛盾
    const conflict = await call('post', '/api/inspirations/bulk-tag', {
      ids: [cardId],
      addTagIds: [tagId],
      removeTagIds: [tagId],
    });
    expect(conflict.status).toBe(400);
  });
});
