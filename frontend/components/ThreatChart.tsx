"use client";

import { useReadContract } from "wagmi";
import { REGISTRY_ABI, REGISTRY_ADDRESS } from "@/lib/contracts";
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

interface ThreatReport {
  reporter: string;
  targetContract: string;
  threatScore: bigint;
  attackType: string;
  evidence: string;
  timestamp: bigint;
  blockNumber: bigint;
}

interface ChartDataPoint {
  block: number;
  score: number;
  attackType: string;
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
      <p className="text-gray-500">{data.time}</p>
    </div>
  );
}

export function ThreatChart({
  contractAddress,
}: {
  contractAddress?: `0x${string}`;
}) {
  const { data: reports, isLoading } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: "getReports",
    args: contractAddress
      ? [contractAddress, BigInt(0), BigInt(20)]
      : undefined,
    query: { enabled: !!contractAddress },
  });

  const reportList = (reports as ThreatReport[]) || [];

  const chartData: ChartDataPoint[] = reportList.map((r) => ({
    block: Number(r.blockNumber),
    score: Number(r.threatScore),
    attackType: r.attackType,
    time: new Date(Number(r.timestamp) * 1000).toLocaleTimeString(),
  }));

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
