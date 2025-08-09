import https from "node:https";
import { performance } from "node:perf_hooks";

const WORKER_HOST = process.env.WORKER_HOST!; // 你的域名，如 "api.example.com"
const BYTES = Number(process.env.BYTES || "5000000");
const REPORT_URL = `https://${WORKER_HOST}/api/report`;
const CAND_URL = `https://${WORKER_HOST}/api/candidates`;

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

function downloadViaIP(ip: string, bytes: number): Promise<{ ip: string; durationMs: number; ok: boolean }> {
  return new Promise((resolve) => {
    const path = `/dl?bytes=${bytes}`;
    const options: https.RequestOptions = {
      host: ip,
      servername: WORKER_HOST,          // SNI
      port: 443,
      method: "GET",
      path,
      headers: { Host: WORKER_HOST },   // HTTP/1.1 Host
      rejectUnauthorized: true,         // 依赖有效证书
      timeout: 15000,
    };
    const start = performance.now();
    const req = https.request(options, (res) => {
      let received = 0;
      res.on("data", (chunk) => (received += (chunk as Buffer).length));
      res.on("end", () => {
        const dur = performance.now() - start;
        resolve({ ip, durationMs: dur, ok: received > 0 });
      });
    });
    req.on("error", () => resolve({ ip, durationMs: 999999, ok: false }));
    req.on("timeout", () => { req.destroy(); resolve({ ip, durationMs: 999999, ok: false }); });
    req.end();
  });
}

function postJson(url: string, payload: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload));
    const req = https.request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": data.length,
      },
      servername: WORKER_HOST,
    }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const { candidates } = await fetchJson(CAND_URL);
  const pool: string[] = candidates;

  const limit = Number(process.env.CONCURRENCY || "20");
  const tasks = pool.map((ip) => async () => {
    const r = await downloadViaIP(ip, BYTES);
    if (r.ok && r.durationMs < 900000) {
      const sample = {
        ip,
        bytes: BYTES,
        durationMs: Math.max(1, Math.round(r.durationMs)),
        ts: Date.now(),
      };
      await postJson(REPORT_URL, sample);
      const tpMbps = (BYTES * 8) / (r.durationMs / 1000) / 1_000_000;
      console.log(ip, tpMbps.toFixed(2), "Mbps");
    } else {
      console.log(ip, "failed");
    }
  });

  // 简单并发器
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
