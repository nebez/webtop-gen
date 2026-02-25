#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULTS = {
    updates: 10,
    intervalMs: 1000,
    iface: "",
    maxDisks: 8,
    cpuTempId: "",
    diskTempId: "",
    upsServer: "",
};

const EXCLUDED_FS = new Set([
    "tmpfs",
    "devtmpfs",
    "overlay",
    "squashfs",
    "proc",
    "sysfs",
    "cgroup",
    "cgroup2",
    "tracefs",
    "debugfs",
    "mqueue",
    "hugetlbfs",
    "fusectl",
    "securityfs",
    "pstore",
    "configfs",
    "ramfs",
    "autofs",
]);

function parseArgs(argv) {
    const options = { ...DEFAULTS };
    const overrides = new Set();

    for (const arg of argv) {
        if (arg === "--help" || arg === "-h") {
            options.help = true;
            continue;
        }
        if (!arg.startsWith("--")) continue;
        const [keyRaw, valueRaw] = arg.slice(2).split("=");
        const key = keyRaw.trim();
        const value = (valueRaw ?? "").trim();

        if (key === "updates" && value) {
            options.updates = Number(value);
            overrides.add("updates");
        }
        if (key === "interval-ms" && value) {
            options.intervalMs = Number(value);
            overrides.add("interval-ms");
        }
        if (key === "out" && value) {
            options.out = value;
            overrides.add("out");
        }
        if (key === "iface" && value) {
            options.iface = value;
            overrides.add("iface");
        }
        if (key === "max-disks" && value) {
            options.maxDisks = Number(value);
            overrides.add("max-disks");
        }
        if (key === "cpu-temp-id" && value) {
            options.cpuTempId = value;
            overrides.add("cpu-temp-id");
        }
        if (key === "disk-temp-id" && value) {
            options.diskTempId = value;
            overrides.add("disk-temp-id");
        }
        if (key === "ups-server" && value) {
            options.upsServer = value;
            overrides.add("ups-server");
        }
    }

    options.updates = clampInt(options.updates, 1, 600);
    options.intervalMs = clampInt(options.intervalMs, 100, 60000);
    options.maxDisks = clampInt(options.maxDisks, 1, 64);
    options.upsServer = normalizeUpsServerTarget(options.upsServer);
    return { options, overrides };
}

function clampInt(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, Math.floor(value)));
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage() {
    console.log(`Usage:
  node webtop-gen.js [options]

Options:
  --updates=<n>       Number of tick updates to capture (default: 10)
  --interval-ms=<n>   Milliseconds between samples (default: 1000)
  --out=<path>        Output JSON path (required)
  --iface=<name>      Network interface override (default: auto)
  --max-disks=<n>     Max number of disk rows to emit (default: 8)
  --cpu-temp-id=<id>  Preferred CPU temp sensor id, e.g. k10temp-pci-00c3/Tctl
  --disk-temp-id=<id> Preferred disk temp sensor id, e.g. nvme-pci-0300/Composite
  --ups-server=<id>   Optional NUT target for "upsc", e.g. ups@10.88.111.111
  --help              Show this help
`);
}

function logResolvedOptions(options, overrides) {
    const ifaceDisplay = options.iface || "auto";
    console.log("Resolved options:");
    console.log(
        `  updates: ${DEFAULTS.updates} -> ${options.updates}${overrides.has("updates") ? " (override)" : ""}`,
    );
    console.log(
        `  interval-ms: ${DEFAULTS.intervalMs} -> ${options.intervalMs}${overrides.has("interval-ms") ? " (override)" : ""}`,
    );
    console.log(
        `  iface: auto -> ${ifaceDisplay}${overrides.has("iface") ? " (override)" : ""}`,
    );
    console.log(
        `  max-disks: ${DEFAULTS.maxDisks} -> ${options.maxDisks}${overrides.has("max-disks") ? " (override)" : ""}`,
    );
    console.log(
        `  cpu-temp-id: auto -> ${options.cpuTempId || "auto"}${overrides.has("cpu-temp-id") ? " (override)" : ""}`,
    );
    console.log(
        `  disk-temp-id: auto -> ${options.diskTempId || "auto"}${overrides.has("disk-temp-id") ? " (override)" : ""}`,
    );
    console.log(
        `  ups-server: off -> ${options.upsServer || "off"}${overrides.has("ups-server") ? " (override)" : ""}`,
    );
    console.log(
        `  out: ${options.out}${overrides.has("out") ? " (override)" : ""}`,
    );
}

function normalizeUpsServerTarget(value) {
    const trimmed = value.trim();
    if (!trimmed) return "";

    const match = /^upsc\s+(.+)$/i.exec(trimmed);
    if (match && match[1]) {
        return match[1].trim();
    }
    return trimmed;
}

function round2(value) {
    return Math.round(value * 100) / 100;
}

function round1(value) {
    return Math.round(value * 10) / 10;
}

function parseOptionalNumber(value) {
    if (!value) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return round2(parsed);
}

function parseUpscOutput(raw) {
    const values = {};

    for (const line of raw.split("\n")) {
        const separator = line.indexOf(":");
        if (separator === -1) continue;
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (!key) continue;
        values[key] = value;
    }

    return values;
}

function formatExecError(error) {
    if (error && typeof error === "object") {
        const stderr = Reflect.get(error, "stderr");
        if (typeof stderr === "string" && stderr.trim()) {
            return stderr.trim();
        }
    }

    if (error instanceof Error && error.message) {
        return error.message;
    }
    return String(error);
}

async function readUpsSnapshot(upsServer) {
    if (!upsServer) return null;

    try {
        const { stdout } = await execFileAsync("upsc", [upsServer], {
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
        });
        const values = parseUpscOutput(stdout || "");

        return {
            source: "nut",
            status: values["ups.status"] ?? "unknown",
            batteryChargePct: parseOptionalNumber(values["battery.charge"]),
            batteryRuntimeSec: parseOptionalNumber(values["battery.runtime"]),
            loadPct: parseOptionalNumber(values["ups.load"]),
            outputVoltageV: parseOptionalNumber(values["output.voltage"]),
        };
    } catch (error) {
        console.log(
            `UPS snapshot unresolved for "${upsServer}" (${formatExecError(error)}).`,
        );
        return {
            source: "nut",
            status: "unavailable",
        };
    }
}

function parseMeminfo(raw) {
    const map = new Map();
    for (const line of raw.split("\n")) {
        const [keyPart, rest] = line.split(":");
        if (!keyPart || !rest) continue;
        const value = Number(rest.trim().split(/\s+/)[0]);
        if (Number.isFinite(value)) {
            map.set(keyPart.trim(), value);
        }
    }

    const totalKb = map.get("MemTotal") ?? 0;
    const availKb = map.get("MemAvailable") ?? 0;
    const cachedKb = (map.get("Cached") ?? 0) + (map.get("SReclaimable") ?? 0);
    const usedKb = Math.max(0, totalKb - availKb);

    const toGb = (kb) => round2(kb / 1024 / 1024);
    const pct = (v) => (totalKb > 0 ? Math.round((v / totalKb) * 100) : 0);

    return {
        usedGb: toGb(usedKb),
        availableGb: toGb(availKb),
        cachedGb: toGb(cachedKb),
        usedPct: pct(usedKb),
        availablePct: pct(availKb),
        cachedPct: pct(cachedKb),
    };
}

function parseLoadAvg(raw) {
    const [one = "0", five = "0", fifteen = "0"] = raw.trim().split(/\s+/);
    return [
        round2(Number(one) || 0),
        round2(Number(five) || 0),
        round2(Number(fifteen) || 0),
    ];
}

function parseCpuStats(raw) {
    const lines = raw.split("\n");
    const stats = new Map();

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("cpu")) continue;
        const parts = trimmed.split(/\s+/);
        const name = parts[0];
        if (!/^cpu\d*$/.test(name)) continue;

        const nums = parts.slice(1).map((value) => Number(value) || 0);
        const user = nums[0] ?? 0;
        const nice = nums[1] ?? 0;
        const system = nums[2] ?? 0;
        const idle = nums[3] ?? 0;
        const iowait = nums[4] ?? 0;
        const irq = nums[5] ?? 0;
        const softirq = nums[6] ?? 0;
        const steal = nums[7] ?? 0;

        const idleTotal = idle + iowait;
        const activeTotal = user + nice + system + irq + softirq + steal;
        stats.set(name, { total: idleTotal + activeTotal, idle: idleTotal });
    }

    return stats;
}

function computeCpuUsagePct(prevStats, currStats, key) {
    const prev = prevStats.get(key);
    const curr = currStats.get(key);
    if (!prev || !curr) return 0;

    const deltaTotal = curr.total - prev.total;
    const deltaIdle = curr.idle - prev.idle;
    if (deltaTotal <= 0) return 0;

    const usage = ((deltaTotal - deltaIdle) / deltaTotal) * 100;
    return Math.round(clamp(usage, 0, 100));
}

function parseNetDev(raw) {
    const totals = new Map();
    const lines = raw.split("\n").slice(2);
    for (const line of lines) {
        if (!line.includes(":")) continue;
        const [ifacePart, rest] = line.split(":");
        const iface = ifacePart.trim();
        const nums = rest
            .trim()
            .split(/\s+/)
            .map((value) => Number(value) || 0);
        if (nums.length < 16) continue;

        totals.set(iface, {
            rxBytes: nums[0] ?? 0,
            txBytes: nums[8] ?? 0,
        });
    }
    return totals;
}

function parseDefaultRouteIface(raw) {
    const lines = raw.split("\n").slice(1);
    for (const line of lines) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 4) continue;
        const iface = cols[0];
        const destination = cols[1];
        const flags = Number.parseInt(cols[3], 16);
        const isDefault = destination === "00000000";
        const isUp = Number.isFinite(flags) && (flags & 0x2) === 0x2;
        if (isDefault && isUp) return iface;
    }
    return "";
}

function selectNetInterface(netDevMap, preferredIface, defaultRouteIface) {
    if (preferredIface && netDevMap.has(preferredIface)) return preferredIface;
    if (defaultRouteIface && netDevMap.has(defaultRouteIface))
        return defaultRouteIface;

    const candidates = [...netDevMap.keys()].filter((name) => name !== "lo");
    return candidates[0] ?? [...netDevMap.keys()][0] ?? "lo";
}

async function readSensorsOutput() {
    try {
        const { stdout } = await execFileAsync("sensors", [], {
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
        });
        return stdout || "";
    } catch {
        return "";
    }
}

function normalizeSensorIdentifier(value) {
    return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseSensorsOutput(raw) {
    let currentChip = "";
    const entries = [];

    const lines = raw.split("\n");
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (
            !line.startsWith(" ") &&
            !line.startsWith("\t") &&
            !trimmed.includes(":")
        ) {
            currentChip = trimmed;
            continue;
        }

        const measureMatch =
            /^\s*([^:]+):\s*\+?(-?\d+(?:\.\d+)?)\s*°?C\b/i.exec(line);
        if (!measureMatch) continue;

        const label = measureMatch[1].trim();
        const celsius = Number(measureMatch[2]);
        if (!Number.isFinite(celsius) || celsius < -20 || celsius > 150)
            continue;

        const chip = currentChip || "unknown-chip";
        const id = `${chip}/${label}`;
        entries.push({
            chip,
            label,
            id,
            celsius: round1(celsius),
            normalizedId: normalizeSensorIdentifier(id),
        });
    }

    return {
        entries,
    };
}

function findSensorEntryById(entries, identifier) {
    const normalized = normalizeSensorIdentifier(identifier);
    return entries.find((entry) => entry.normalizedId.includes(normalized));
}

function selectCpuTempFromSensors(entries, preferredId) {
    if (preferredId) {
        const selected = findSensorEntryById(entries, preferredId);
        if (!selected) return null;
        return {
            tempC: selected.celsius,
            source: `sensors:${selected.id}`,
        };
    }

    const cpuCandidates = entries
        .filter((entry) => {
            const chip = entry.chip.toLowerCase();
            const label = entry.label.toLowerCase();
            return (
                /k10temp|coretemp|cpu|x86_pkg_temp|package/.test(chip) &&
                /(tctl|tdie|package|cpu|temp1)/.test(label)
            );
        })
        .sort((a, b) => b.celsius - a.celsius);

    const selected = cpuCandidates[0];
    if (!selected) return null;
    return {
        tempC: selected.celsius,
        source: `sensors:${selected.id}`,
    };
}

function selectDiskTempFromSensors(entries, preferredId) {
    if (preferredId) {
        const selected = findSensorEntryById(entries, preferredId);
        if (!selected) return null;
        return {
            tempC: selected.celsius,
            source: `sensors:${selected.id}`,
        };
    }

    const diskCandidates = entries
        .filter((entry) => {
            const chip = entry.chip.toLowerCase();
            const label = entry.label.toLowerCase();
            return (
                /nvme|drivetemp|ssd|ata/.test(chip) &&
                /(composite|temp1|temperature)/.test(label)
            );
        })
        .sort((a, b) => b.celsius - a.celsius);

    const selected = diskCandidates[0];
    if (!selected) return null;
    return {
        tempC: selected.celsius,
        source: `sensors:${selected.id}`,
    };
}

function looksLikeCpuTemp(name, label) {
    const text = `${name} ${label}`.toLowerCase();
    return (
        text.includes("cpu") ||
        text.includes("package") ||
        text.includes("coretemp") ||
        text.includes("k10temp") ||
        text.includes("x86_pkg_temp") ||
        text.includes("tctl") ||
        text.includes("tdie")
    );
}

function scoreTempProbe(name, label) {
    const text = `${name} ${label}`.toLowerCase();
    let score = 0;
    if (text.includes("x86_pkg_temp")) score += 120;
    if (text.includes("package")) score += 100;
    if (text.includes("cpu")) score += 80;
    if (text.includes("coretemp")) score += 75;
    if (text.includes("k10temp")) score += 75;
    if (text.includes("tctl")) score += 70;
    if (text.includes("tdie")) score += 70;
    if (text.includes("thermal")) score += 20;
    return score;
}

function normalizeTempValue(rawValue) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return null;
    const celsius = value > 1000 ? value / 1000 : value;
    if (celsius < -20 || celsius > 150) return null;
    return round1(celsius);
}

async function createCpuTempReader(preferredCpuTempId) {
    const probes = [];

    try {
        const thermalBase = "/sys/class/thermal";
        const thermalEntries = await readdir(thermalBase, {
            withFileTypes: true,
        });
        for (const entry of thermalEntries) {
            if (!entry.isDirectory() || !entry.name.startsWith("thermal_zone"))
                continue;
            const zonePath = path.join(thermalBase, entry.name);

            let type = "";
            try {
                type = (
                    await readFile(path.join(zonePath, "type"), "utf8")
                ).trim();
            } catch {
                // Ignore missing type metadata.
            }

            probes.push({
                source: "thermal",
                name: type || entry.name,
                label: entry.name,
                tempPath: path.join(zonePath, "temp"),
            });
        }
    } catch {
        // Ignore unavailable thermal tree.
    }

    try {
        const hwmonBase = "/sys/class/hwmon";
        const hwmonEntries = await readdir(hwmonBase, { withFileTypes: true });
        for (const hwmonEntry of hwmonEntries) {
            if (!hwmonEntry.isDirectory()) continue;
            const dirPath = path.join(hwmonBase, hwmonEntry.name);

            let chipName = hwmonEntry.name;
            try {
                chipName =
                    (
                        await readFile(path.join(dirPath, "name"), "utf8")
                    ).trim() || chipName;
            } catch {
                // Ignore missing hwmon name.
            }

            let files = [];
            try {
                files = await readdir(dirPath);
            } catch {
                continue;
            }

            for (const file of files) {
                const match = /^temp(\d+)_input$/.exec(file);
                if (!match) continue;
                const sensorId = match[1];
                const labelPath = path.join(dirPath, `temp${sensorId}_label`);

                let label = "";
                try {
                    label = (await readFile(labelPath, "utf8")).trim();
                } catch {
                    // Label is optional.
                }

                probes.push({
                    source: "hwmon",
                    name: chipName,
                    label: label || `temp${sensorId}`,
                    tempPath: path.join(dirPath, file),
                });
            }
        }
    } catch {
        // Ignore unavailable hwmon tree.
    }

    const cpuHintCount = probes.filter((probe) =>
        looksLikeCpuTemp(probe.name, probe.label),
    ).length;
    let sensorsAvailable = false;

    async function read() {
        if (preferredCpuTempId) {
            const sensorsRaw = await readSensorsOutput();
            if (sensorsRaw) {
                sensorsAvailable = true;
                const sensors = parseSensorsOutput(sensorsRaw);
                const selected = selectCpuTempFromSensors(
                    sensors.entries,
                    preferredCpuTempId,
                );
                if (selected) {
                    return selected;
                }
                return {
                    tempC: 0,
                    source: `sensors:missing:${preferredCpuTempId}`,
                };
            }
            return {
                tempC: 0,
                source: `sensors:unavailable:${preferredCpuTempId}`,
            };
        }

        const candidates = [];

        for (const probe of probes) {
            try {
                const raw = (await readFile(probe.tempPath, "utf8")).trim();
                const celsius = normalizeTempValue(raw);
                if (celsius == null) continue;

                candidates.push({
                    celsius,
                    score: scoreTempProbe(probe.name, probe.label),
                    source: `${probe.source}:${probe.name}/${probe.label}`,
                });
            } catch {
                // Probe may disappear or be unreadable.
            }
        }

        if (candidates.length === 0) {
            const sensorsRaw = await readSensorsOutput();
            if (sensorsRaw) {
                sensorsAvailable = true;
                const sensors = parseSensorsOutput(sensorsRaw);
                const selected = selectCpuTempFromSensors(sensors.entries, "");
                if (selected) {
                    return selected;
                }
            }
            return {
                tempC: 0,
                source: sensorsAvailable ? "sensors:no-cpu-temp" : "none",
            };
        }

        const cpuCandidates = candidates.filter(
            (candidate) => candidate.score > 0,
        );
        const pool = cpuCandidates.length > 0 ? cpuCandidates : candidates;

        pool.sort((a, b) => b.score - a.score || b.celsius - a.celsius);
        const selected = pool[0];

        return {
            tempC: round1(selected.celsius),
            source: selected.source,
        };
    }

    return {
        probeCount: probes.length,
        cpuHintCount,
        sensorsAvailable: () => sensorsAvailable,
        read,
    };
}

function buildDiskName(mountPoint) {
    if (mountPoint === "/") return "root";
    return mountPoint.replace(/^\//, "").replace(/\//g, "-") || "root";
}

async function readDiskRows(maxDisks) {
    const args = ["-B1", "-P"];
    for (const fsName of EXCLUDED_FS) {
        args.push("-x", fsName);
    }

    let stdout = "";
    try {
        ({ stdout } = await execFileAsync("df", args, {
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
        }));
    } catch {
        return {
            rows: [],
            skippedEfi: 0,
        };
    }

    const rows = [];
    let skippedEfi = 0;
    const lines = stdout.trim().split("\n").slice(1);
    for (const line of lines) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 6) continue;

        const totalBytes = Number(cols[1]) || 0;
        const usedBytes = Number(cols[2]) || 0;
        const fsName = cols[0];
        const mountPoint = cols[5];
        if (!mountPoint || mountPoint.startsWith("/snap")) continue;
        if (fsName.startsWith("tmpfs") || fsName.startsWith("devtmpfs"))
            continue;

        const name = buildDiskName(mountPoint);
        if (/efi/i.test(name)) {
            skippedEfi += 1;
            continue;
        }

        const usagePct =
            totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
        rows.push({
            name,
            totalGb: round2(totalBytes / 1024 / 1024 / 1024),
            usagePct: clamp(usagePct, 0, 100),
        });
    }

    const deduped = [];
    const seen = new Set();
    for (const row of rows) {
        if (seen.has(row.name)) continue;
        seen.add(row.name);
        deduped.push(row);
        if (deduped.length >= maxDisks) break;
    }
    return {
        rows: deduped,
        skippedEfi,
    };
}

async function readStaticSnapshot(maxDisks, preferredDiskTempId) {
    const [memRaw, diskSnapshot, sensorsRaw] = await Promise.all([
        readFile("/proc/meminfo", "utf8"),
        readDiskRows(maxDisks),
        readSensorsOutput(),
    ]);

    const sensors = parseSensorsOutput(sensorsRaw);
    const selectedDiskTemp = selectDiskTempFromSensors(
        sensors.entries,
        preferredDiskTempId,
    );

    return {
        memory: parseMeminfo(memRaw),
        disks: diskSnapshot.rows,
        diskTempC: selectedDiskTemp?.tempC ?? null,
        diskTempSource: selectedDiskTemp?.source ?? "none",
        skippedEfi: diskSnapshot.skippedEfi,
        sensorsEntryCount: sensors.entries.length,
    };
}

async function readDynamicSnapshot(preferredIface, cpuTempReader) {
    const [cpuRaw, loadRaw, netRaw, routeRaw, tempSnapshot] = await Promise.all(
        [
            readFile("/proc/stat", "utf8"),
            readFile("/proc/loadavg", "utf8"),
            readFile("/proc/net/dev", "utf8"),
            readFile("/proc/net/route", "utf8"),
            cpuTempReader.read(),
        ],
    );

    const cpuStats = parseCpuStats(cpuRaw);
    const loadAvg = parseLoadAvg(loadRaw);
    const netMap = parseNetDev(netRaw);
    const defaultIface = parseDefaultRouteIface(routeRaw);
    const iface = selectNetInterface(netMap, preferredIface, defaultIface);
    const net = netMap.get(iface) ?? { rxBytes: 0, txBytes: 0 };

    return {
        timestampMs: Date.now(),
        cpuStats,
        loadAvg,
        tempC: tempSnapshot.tempC,
        tempSource: tempSnapshot.source,
        iface,
        rxBytes: net.rxBytes,
        txBytes: net.txBytes,
    };
}

async function collectUpdates(
    updateCount,
    intervalMs,
    preferredIface,
    cpuTempReader,
) {
    let previous = await readDynamicSnapshot(preferredIface, cpuTempReader);
    const updates = [];

    for (let i = 0; i < updateCount; i += 1) {
        await sleep(intervalMs);
        const current = await readDynamicSnapshot(
            previous.iface || preferredIface,
            cpuTempReader,
        );

        const deltaSec = Math.max(
            0.001,
            (current.timestampMs - previous.timestampMs) / 1000,
        );
        const threadKeys = [...current.cpuStats.keys()]
            .filter((key) => /^cpu\d+$/.test(key))
            .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));

        const perThreadPct = threadKeys.map((key) =>
            computeCpuUsagePct(previous.cpuStats, current.cpuStats, key),
        );
        const totalUsagePct = computeCpuUsagePct(
            previous.cpuStats,
            current.cpuStats,
            "cpu",
        );

        const downloadKibps = round2(
            Math.max(0, (current.rxBytes - previous.rxBytes) / deltaSec / 1024),
        );
        const uploadKibps = round2(
            Math.max(0, (current.txBytes - previous.txBytes) / deltaSec / 1024),
        );

        updates.push({
            cpu: {
                perThreadPct,
                totalUsagePct,
                loadAvg: current.loadAvg,
                tempC: current.tempC,
            },
            network: {
                downloadKibps,
                uploadKibps,
            },
        });

        console.log(
            `tick ${i + 1}/${updateCount}: cpu=${totalUsagePct}% temp=${current.tempC.toFixed(1)}C net=${downloadKibps}/${uploadKibps} kibps iface=${current.iface}`,
        );
        if (current.tempC === 0) {
            console.log(`  temp source unresolved (${current.tempSource}).`);
        }

        previous = current;
    }

    return updates;
}

async function main() {
    const { options, overrides } = parseArgs(process.argv.slice(2));

    if (options.help) {
        usage();
        return;
    }

    if (process.platform !== "linux") {
        throw new Error("This script requires Linux (/proc and /sys).");
    }

    if (!options.out) {
        throw new Error("Missing required option: --out=<path>");
    }

    logResolvedOptions(options, overrides);

    const cpuTempReader = await createCpuTempReader(options.cpuTempId);
    console.log(
        `CPU temp probes: found=${cpuTempReader.probeCount}, cpu-hints=${cpuTempReader.cpuHintCount}`,
    );
    if (cpuTempReader.probeCount === 0) {
        console.log(
            "CPU temp note: no readable probes found in /sys/class/thermal or /sys/class/hwmon; temp will report 0C.",
        );
    } else if (cpuTempReader.cpuHintCount === 0) {
        console.log(
            "CPU temp note: probes found but none looked CPU-specific; using best available sensor match.",
        );
    }
    if (options.cpuTempId) {
        console.log(
            `CPU temp selection: forcing sensors id match for "${options.cpuTempId}"`,
        );
    }

    console.log("Reading static snapshot...");
    const [staticSnapshot, upsSnapshot] = await Promise.all([
        readStaticSnapshot(options.maxDisks, options.diskTempId),
        readUpsSnapshot(options.upsServer),
    ]);
    console.log(
        `Static snapshot: disks=${staticSnapshot.disks.length} (filtered efi=${staticSnapshot.skippedEfi}, sensors-entries=${staticSnapshot.sensorsEntryCount})`,
    );
    if (options.diskTempId) {
        console.log(
            `Disk temp selection: forcing sensors id match for "${options.diskTempId}"`,
        );
    }
    if (staticSnapshot.diskTempC != null) {
        console.log(
            `Disk temp selected: ${staticSnapshot.diskTempC.toFixed(1)}C from ${staticSnapshot.diskTempSource}`,
        );
    } else {
        console.log(
            `Disk temp unresolved (source=${staticSnapshot.diskTempSource}).`,
        );
    }
    if (options.upsServer && upsSnapshot?.status !== "unavailable") {
        const chargeDisplay = upsSnapshot?.batteryChargePct ?? "n/a";
        const loadDisplay = upsSnapshot?.loadPct ?? "n/a";
        console.log(
            `UPS snapshot: status=${upsSnapshot?.status ?? "unknown"} charge=${chargeDisplay}% load=${loadDisplay}%`,
        );
    }

    console.log(
        `Capturing ${options.updates} updates every ${options.intervalMs}ms...`,
    );
    const updates = await collectUpdates(
        options.updates,
        options.intervalMs,
        options.iface,
        cpuTempReader,
    );
    if (cpuTempReader.sensorsAvailable()) {
        console.log(
            "CPU temp source: using sensors fallback when sysfs probes are unavailable.",
        );
    }

    const payload = {
        memory: staticSnapshot.memory,
        disks: staticSnapshot.disks,
        diskTempC: staticSnapshot.diskTempC,
        updates,
        ...(upsSnapshot ? { ups: upsSnapshot } : {}),
    };

    const outPath = path.resolve(process.cwd(), options.out);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(payload, null, 4)}\n`, "utf8");

    console.log(
        `Done: captured ${updates.length} updates (${updates[0]?.cpu.perThreadPct.length ?? 0} threads) -> ${outPath}`,
    );
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
