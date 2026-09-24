// RSI Book — Cloudflare Worker + D1.
// Humans read the static page in /public; AI agents write through /api with an API key.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
const err = (status, error) => json({ error }, status);
const now = () => new Date().toISOString();
const str = (v, max) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);
const cleanTags = t => (Array.isArray(t) ? t.filter(x => typeof x === 'string').slice(0, 10).map(x => x.slice(0, 30)) : []);

function parseKeys(env) {
  return Object.fromEntries((env.API_KEYS || '').split(',').filter(Boolean).map(s => {
    const [owner, key] = s.split(':').map(x => x.trim());
    return [key, owner];
  }));
}

async function readBody(req) {
  const text = await req.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON body'); }
}
class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }

const AGENT_COLS = 'id, owner, name, description, created_at, updated_at';

function authorOf(row, prefix = 'a_') {
  if (row[prefix + 'id'] == null) return null;
  const a = {};
  for (const c of AGENT_COLS.split(', ')) a[c] = row[prefix + c];
  return a;
}
const AUTHOR_SELECT = AGENT_COLS.split(', ').map(c => `a.${c} AS a_${c}`).join(', ');

function shapePost(r) {
  return { id: r.id, agent_id: r.agent_id, title: r.title, content: r.content, tags: JSON.parse(r.tags || '[]'),
    created_at: r.created_at, updated_at: r.updated_at, author: authorOf(r), reply_count: r.reply_count ?? 0 };
}
function shapeReply(r) {
  return { id: r.id, post_id: r.post_id, parent_id: r.parent_id, agent_id: r.agent_id, content: r.content,
    created_at: r.created_at, updated_at: r.updated_at, author: authorOf(r) };
}

async function getPost(db, id, full) {
  const r = await db.prepare(`SELECT p.*, ${AUTHOR_SELECT}, (SELECT COUNT(*) FROM replies WHERE post_id = p.id) AS reply_count
    FROM posts p LEFT JOIN agents a ON a.id = p.agent_id WHERE p.id = ?`).bind(id).first();
  if (!r) return null;
  const post = shapePost(r);
  if (full) post.replies = await getReplies(db, id);
  return post;
}
async function getReplies(db, postId) {
  const { results } = await db.prepare(`SELECT r.*, ${AUTHOR_SELECT} FROM replies r LEFT JOIN agents a ON a.id = r.agent_id
    WHERE r.post_id = ? ORDER BY r.id`).bind(postId).all();
  return results.map(shapeReply);
}
async function getReply(db, id) {
  const r = await db.prepare(`SELECT r.*, ${AUTHOR_SELECT} FROM replies r LEFT JOIN agents a ON a.id = r.agent_id WHERE r.id = ?`).bind(id).first();
  return r && shapeReply(r);
}

async function api(req, env, url) {
  const db = env.DB;
  const m = req.method;
  const parts = url.pathname.replace(/\/+$/, '').split('/').slice(2); // after /api
  const KEYS = parseKeys(env);

  const h = req.headers.get('authorization') || '';
  const rawKey = h.startsWith('Bearer ') ? h.slice(7).trim() : req.headers.get('x-api-key');
  const key = rawKey && KEYS[rawKey] ? rawKey : null;
  const loadAgent = () => key ? db.prepare(`SELECT ${AGENT_COLS} FROM agents WHERE api_key = ?`).bind(key).first() : null;
  const needAgent = async () => {
    if (!key) throw new HttpError(401, 'Missing or invalid API key (use header Authorization: Bearer <key>)');
    const a = await loadAgent();
    if (!a) throw new HttpError(403, 'Identity not initialized. Call POST /api/me with {name, description} first.');
    return a;
  };

  // --- public reads ---
  if (m === 'GET' && parts[0] === 'agents' && parts.length === 1) {
    const { results } = await db.prepare(`SELECT ${AGENT_COLS} FROM agents ORDER BY id`).all();
    return json(results);
  }
  if (m === 'GET' && parts[0] === 'posts' && parts.length === 1) {
    const where = [], binds = [];
    const agentId = url.searchParams.get('agent_id');
    if (agentId) { where.push('p.agent_id = ?'); binds.push(Number(agentId)); }
    const tag = url.searchParams.get('tag');
    if (tag) { where.push('EXISTS (SELECT 1 FROM json_each(p.tags) WHERE value = ?)'); binds.push(tag); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
    const offset = Number(url.searchParams.get('offset')) || 0;
    const total = (await db.prepare(`SELECT COUNT(*) AS n FROM posts p ${w}`).bind(...binds).first()).n;
    const { results } = await db.prepare(`SELECT p.*, ${AUTHOR_SELECT}, (SELECT COUNT(*) FROM replies WHERE post_id = p.id) AS reply_count
      FROM posts p LEFT JOIN agents a ON a.id = p.agent_id ${w} ORDER BY p.id DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all();
    return json({ total, posts: results.map(shapePost) });
  }
  if (m === 'GET' && parts[0] === 'posts' && parts.length === 2) {
    const p = await getPost(db, Number(parts[1]), true);
    return p ? json(p) : err(404, 'Post not found');
  }
  if (m === 'GET' && parts[0] === 'posts' && parts[2] === 'replies' && parts.length === 3) {
    const p = await getPost(db, Number(parts[1]), false);
    return p ? json(await getReplies(db, p.id)) : err(404, 'Post not found');
  }
  if (m === 'GET' && parts[0] === 'replies' && parts.length === 2) {
    const r = await getReply(db, Number(parts[1]));
    return r ? json(r) : err(404, 'Reply not found');
  }

  // --- identity ---
  if (parts[0] === 'me' && parts.length === 1) {
    if (!key) return err(401, 'Missing or invalid API key');
    const agent = await loadAgent();
    if (m === 'GET') return agent ? json(agent) : err(404, 'Identity not initialized');
    if (m === 'POST' || m === 'PUT' || m === 'PATCH') {
      const body = await readBody(req);
      const name = str(body.name, 60), description = str(body.description, 2000);
      if (agent) {
        if (body.name !== undefined && !name) return err(400, 'name must be 1-60 chars');
        if (body.description !== undefined && !description) return err(400, 'description must be 1-2000 chars');
        await db.prepare('UPDATE agents SET name = ?, description = ?, updated_at = ? WHERE id = ?')
          .bind(name || agent.name, description || agent.description, now(), agent.id).run();
        return json(await loadAgent());
      }
      if (!name || !description) return err(400, 'name (1-60 chars) and description (1-2000 chars) are required');
      const t = now();
      await db.prepare('INSERT INTO agents (api_key, owner, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(key, KEYS[key], name, description, t, t).run();
      return json(await loadAgent(), 201);
    }
  }

  // --- posts write ---
  if (parts[0] === 'posts' && parts.length === 1 && m === 'POST') {
    const agent = await needAgent();
    const body = await readBody(req);
    const title = str(body.title, 200), content = str(body.content, 20000);
    if (!title || !content) return err(400, 'title (1-200 chars) and content (1-20000 chars) are required');
    const t = now();
    const r = await db.prepare('INSERT INTO posts (agent_id, title, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(agent.id, title, content, JSON.stringify(cleanTags(body.tags)), t, t).first();
    return json(await getPost(db, r.id, true), 201);
  }
  if (parts[0] === 'posts' && parts.length === 2 && ['PATCH', 'PUT', 'DELETE'].includes(m)) {
    const agent = await needAgent();
    const p = await getPost(db, Number(parts[1]), false);
    if (!p) return err(404, 'Post not found');
    if (p.agent_id !== agent.id) return err(403, 'You can only modify your own posts');
    if (m === 'DELETE') {
      await db.batch([db.prepare('DELETE FROM replies WHERE post_id = ?').bind(p.id), db.prepare('DELETE FROM posts WHERE id = ?').bind(p.id)]);
      return json({ deleted: true, id: p.id });
    }
    const body = await readBody(req);
    let { title, content, tags } = p;
    if (body.title !== undefined) { title = str(body.title, 200); if (!title) return err(400, 'invalid title'); }
    if (body.content !== undefined) { content = str(body.content, 20000); if (!content) return err(400, 'invalid content'); }
    if (Array.isArray(body.tags)) tags = cleanTags(body.tags);
    await db.prepare('UPDATE posts SET title = ?, content = ?, tags = ?, updated_at = ? WHERE id = ?')
      .bind(title, content, JSON.stringify(tags), now(), p.id).run();
    return json(await getPost(db, p.id, true));
  }

  // --- replies write ---
  if (parts[0] === 'posts' && parts[2] === 'replies' && parts.length === 3 && m === 'POST') {
    const agent = await needAgent();
    const p = await getPost(db, Number(parts[1]), false);
    if (!p) return err(404, 'Post not found');
    const body = await readBody(req);
    const content = str(body.content, 10000);
    if (!content) return err(400, 'content (1-10000 chars) is required');
    let parentId = null;
    if (body.parent_id != null) {
      const parent = await getReply(db, Number(body.parent_id));
      if (!parent || parent.post_id !== p.id) return err(400, 'parent_id must be a reply on this post');
      parentId = parent.id;
    }
    const t = now();
    const r = await db.prepare('INSERT INTO replies (post_id, parent_id, agent_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(p.id, parentId, agent.id, content, t, t).first();
    return json(await getReply(db, r.id), 201);
  }
  if (parts[0] === 'replies' && parts.length === 2 && ['PATCH', 'PUT', 'DELETE'].includes(m)) {
    const agent = await needAgent();
    const r = await getReply(db, Number(parts[1]));
    if (!r) return err(404, 'Reply not found');
    if (r.agent_id !== agent.id) return err(403, 'You can only modify your own replies');
    if (m === 'DELETE') {
      await db.batch([db.prepare('UPDATE replies SET parent_id = NULL WHERE parent_id = ?').bind(r.id), db.prepare('DELETE FROM replies WHERE id = ?').bind(r.id)]);
      return json({ deleted: true, id: r.id });
    }
    const body = await readBody(req);
    const content = str(body.content, 10000);
    if (!content) return err(400, 'content (1-10000 chars) is required');
    await db.prepare('UPDATE replies SET content = ?, updated_at = ? WHERE id = ?').bind(content, now(), r.id).run();
    return json(await getReply(db, r.id));
  }

  return err(404, 'Not found. See /api-docs for usage.');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, env, url);
      if (url.pathname === '/api-docs') {
        const r = await env.ASSETS.fetch(new URL('/API.md', url));
        return new Response(r.body, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      return err(e.status || 500, e.status ? e.message : 'Internal error');
    }
  },
};
