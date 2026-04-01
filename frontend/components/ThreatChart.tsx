"use client";

import { usePublicClient } from "wagmi";
import { REGISTRY_ABI, REGISTRY_ADDRESS } from "@/lib/contracts";
import { useEffect, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  CartesianGrid,
} from "recharts";

interface ChartDataPoint {
  block: number;
  score: number;
  attackType: string;
  target: string;
  time: string;
}

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartDataPoint }>;
}) {
  if (!active || !payload?.length) return null;
  const data = payload[0].payload;

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs shadow-xl">
      <p className="text-white font-semibold">Score: {data.score}/100</p>
      <p className="text-gray-400">Block #{data.block}</p>
      <p className="text-gray-400">{data.attackType.replace(/_/g, " ")}</p>
      <p className="text-gray-500 font-mono">
        Target: {data.target.slice(0, 8)}...{data.target.slice(-4)}
      </p>
      <p className="text-gray-500">{data.time}</p>
    </div>
  );
}

export function ThreatChart() {
  const publicClient = usePublicClient();
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!publicClient) return;

    async function fetchEvents() {
      try {
        const currentBlock = await publicClient!.getBlockNumber();
        // Look back ~2000 blocks (~3-4 hours on Polkadot Hub)
        const fromBlock = currentBlock > BigInt(2000) ? currentBlock - BigInt(2000) : BigInt(0);

        const logs = await publicClient!.getLogs({
          address: REGISTRY_ADDRESS,
          event: {
            type: "event",
            name: "ThreatReported",
            inputs: [
              { name: "reporter", type: "address", indexed: true },
              { name: "targetContract", type: "address", indexed: true },
              { name: "threatScore", type: "uint256", indexed: false },
              { name: "attackType", type: "string", indexed: false },
              { name: "blockNumber", type: "uint256", indexed: false },
            ],
          },
          fromBlock,
          toBlock: currentBlock,
        });

        const points: ChartDataPoint[] = logs.map((log) => ({
          block: Number(log.args.blockNumber ?? log.blockNumber),
          score: Number(log.args.threatScore ?? 0),
          attackType: log.args.attackType ?? "UNKNOWN",
          target: log.args.targetContract ?? "0x",
          time: new Date().toLocaleTimeString(),
        }));

        // Sort by block ascending
        points.sort((a, b) => a.block - b.block);
        setChartData(points);
      } catch (err) {
        console.error("Failed to fetch ThreatReported events:", err);
      } finally {
        setIsLoading(false);
      }
    }

    fetchEvents();
  }, [publicClient]);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6 animate-pulse">
        <div className="h-6 bg-gray-800 rounded w-1/3 mb-4" />
        <div className="h-48 bg-gray-800 rounded" />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Threat Score History</h2>
        <span className="text-xs text-gray-500">Last 20 reports</span>
      </div>

      {chartData.length === 0 ? (
        <div className="flex items-center justify-center h-48 text-gray-600 text-sm">
          No threat data to display
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: -20 }}>
            <defs>
              <linearGradient id="threatGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                <stop offset="50%" stopColor="#f59e0b" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis
              dataKey="block"
              tick={{ fill: "#6b7280", fontSize: 11 }}
              axisLine={{ stroke: "#374151" }}
              tickLine={false}
              tickFormatter={(v: number) => `#${v}`}
            />
            <YAxis
              domain={[0, 100]}
              tick={{ fill: "#6b7280", fontSize: 11 }}
              axisLine={{ stroke: "#374151" }}
              tickLine={false}
            />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine
              y={80}
              stroke="#ef4444"
              strokeDasharray="4 4"
              strokeOpacity={0.5}
              label={{ value: "Emergency", fill: "#ef4444", fontSize: 10, position: "right" }}
            />
            <ReferenceLine
              y={30}
              stroke="#f59e0b"
              strokeDasharray="4 4"
              strokeOpacity={0.3}
              label={{ value: "LLM trigger", fill: "#f59e0b", fontSize: 10, position: "right" }}
            />
            <Area
              type="monotone"
              dataKey="score"
              stroke="#ef4444"
              strokeWidth={2}
              fill="url(#threatGradient)"
              dot={{ fill: "#ef4444", strokeWidth: 0, r: 3 }}
              activeDot={{ fill: "#ef4444", strokeWidth: 2, stroke: "#fff", r: 5 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
