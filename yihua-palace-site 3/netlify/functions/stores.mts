import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

interface StoreEntry {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  link: string;
  status: "active" | "coming_soon";
  order: number;
}

interface AdminConfig {
  username: string;
  passwordHash: string;
}

const DEFAULT_STORES: StoreEntry[] = [
  {
    id: "taipei-flagship",
    name: "台北旗艦店",
    subtitle: "南京三民站步行約 3 分鐘",
    description: "適合台北市區、松山、信義、內湖與捷運南京三民周邊顧客預約。",
    link: "https://ezpretty.cc/URUYt",
    status: "active",
    order: 1,
  },
  {
    id: "zhonghe-founding",
    name: "中和創始店",
    subtitle: "南勢角站步行約 3 分鐘",
    description: "移花宮第一家門市，適合中和、永和、新店、板橋與南勢角周邊顧客預約。",
    link: "https://ezpretty.cc/1cBJR",
    status: "active",
    order: 2,
  },
];

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return `${base || "store"}-${Date.now().toString(36)}`;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;

  try {
    const candidate = scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, "hex");
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

async function loadAdminConfig(): Promise<AdminConfig> {
  const store = getStore("yihua-admin");
  const config = await store.get("config", { type: "json" });
  if (config && typeof config === "object" && (config as AdminConfig).passwordHash) {
    return config as AdminConfig;
  }

  const seededUser = Netlify.env.get("ADMIN_USER") || "admin";
  const seededPass = Netlify.env.get("ADMIN_PASS") || "";
  const fresh: AdminConfig = {
    username: seededUser,
    passwordHash: hashPassword(seededPass),
  };
  await store.setJSON("config", fresh);
  return fresh;
}

async function saveAdminConfig(config: AdminConfig): Promise<void> {
  const store = getStore("yihua-admin");
  await store.setJSON("config", config);
}

async function checkAuth(req: Request): Promise<boolean> {
  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.startsWith("Basic ")) return false;

  let decoded = "";
  try {
    decoded = atob(authHeader.slice(6));
  } catch {
    return false;
  }

  const idx = decoded.indexOf(":");
  if (idx === -1) return false;

  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);

  const config = await loadAdminConfig();
  return user === config.username && verifyPassword(pass, config.passwordHash);
}

async function loadStores(): Promise<StoreEntry[]> {
  const store = getStore("yihua-stores");
  const list = await store.get("list", { type: "json" });
  if (list && Array.isArray(list)) {
    return list as StoreEntry[];
  }
  await store.setJSON("list", DEFAULT_STORES);
  return DEFAULT_STORES;
}

async function saveStores(list: StoreEntry[]): Promise<void> {
  const store = getStore("yihua-stores");
  await store.setJSON("list", list);
}

export default async (req: Request, context: Context) => {
  if (req.method === "GET") {
    const list = await loadStores();
    const sorted = [...list].sort((a, b) => a.order - b.order);
    return Response.json(sorted);
  }

  if (req.method === "POST") {
    if (!(await checkAuth(req))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }

    const action = body?.action;

    if (action === "change_password") {
      const newPassword = String(body.newPassword || "");
      const newUsernameRaw = body.newUsername !== undefined ? String(body.newUsername).trim() : "";

      if (newPassword.length < 6) {
        return Response.json({ error: "密碼至少需要 6 個字元" }, { status: 400 });
      }

      const current = await loadAdminConfig();
      const updatedConfig: AdminConfig = {
        username: newUsernameRaw || current.username,
        passwordHash: hashPassword(newPassword),
      };
      await saveAdminConfig(updatedConfig);
      return Response.json({ ok: true, username: updatedConfig.username });
    }

    const list = await loadStores();

    if (action === "verify") {
      const config = await loadAdminConfig();
      const sorted = [...list].sort((a, b) => a.order - b.order);
      return Response.json({ ok: true, stores: sorted, username: config.username });
    }

    if (action === "create") {
      const name = String(body.name || "").trim();
      const subtitle = String(body.subtitle || "").trim();
      const description = String(body.description || "").trim();
      const link = String(body.link || "").trim();
      const status = body.status === "active" ? "active" : "coming_soon";

      if (!name || !link) {
        return Response.json({ error: "name and link are required" }, { status: 400 });
      }

      const maxOrder = list.reduce((m, s) => Math.max(m, s.order || 0), 0);
      const newStore: StoreEntry = {
        id: slugify(name),
        name,
        subtitle,
        description,
        link,
        status,
        order: maxOrder + 1,
      };

      const updated = [...list, newStore];
      await saveStores(updated);
      const sorted = [...updated].sort((a, b) => a.order - b.order);
      return Response.json({ ok: true, stores: sorted });
    }

    if (action === "update") {
      const id = String(body.id || "");
      const idx = list.findIndex((s) => s.id === id);
      if (idx === -1) {
        return Response.json({ error: "store not found" }, { status: 404 });
      }

      const existing = list[idx];
      const updatedEntry: StoreEntry = {
        ...existing,
        name: body.name !== undefined ? String(body.name).trim() : existing.name,
        subtitle: body.subtitle !== undefined ? String(body.subtitle).trim() : existing.subtitle,
        description: body.description !== undefined ? String(body.description).trim() : existing.description,
        link: body.link !== undefined ? String(body.link).trim() : existing.link,
        status: body.status === "active" || body.status === "coming_soon" ? body.status : existing.status,
        order: typeof body.order === "number" ? body.order : existing.order,
      };

      const updated = [...list];
      updated[idx] = updatedEntry;
      await saveStores(updated);
      const sorted = [...updated].sort((a, b) => a.order - b.order);
      return Response.json({ ok: true, stores: sorted });
    }

    if (action === "delete") {
      const id = String(body.id || "");
      const updated = list.filter((s) => s.id !== id);
      await saveStores(updated);
      const sorted = [...updated].sort((a, b) => a.order - b.order);
      return Response.json({ ok: true, stores: sorted });
    }

    return Response.json({ error: "unknown action" }, { status: 400 });
  }

  return Response.json({ error: "method not allowed" }, { status: 405 });
};

export const config: Config = {
  path: "/api/stores",
};
