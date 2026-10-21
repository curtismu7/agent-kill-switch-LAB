import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, applyNodeChanges } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

// agent -> gateway [1 revocation check, 2 rate cap, 3 cost cap] -> tools, with the token service and the kill switch.
// The checks are drawn in the order the gateway runs them. Boxes are draggable (arrow keys too). The highlight follows the
// last real step of the run: it is not an animation of its own.
export const START = [
  { id: "token", position: { x: 0, y: 0 }, data: { title: "Token service", sub: "short-lived access tokens" } },
  { id: "kill", position: { x: 250, y: 0 }, data: { title: "Kill switch", sub: "armed / tripped / killed / reset" } },
  { id: "audit", position: { x: 500, y: 0 }, data: { title: "Audit trail", sub: "append-only, hash-chained" } },
  { id: "agent", position: { x: 0, y: 170 }, data: { title: "Agent", sub: "scripted, runaway-prone" } },
  { id: "revoke", position: { x: 250, y: 170 }, data: { title: "1 Revocation check", sub: "kill flag + token, every call" } },
  { id: "rate", position: { x: 500, y: 170 }, data: { title: "2 Rate cap", sub: "sliding window" } },
  { id: "tools", position: { x: 250, y: 340 }, data: { title: "Tools", sub: "mock, in-process" } },
  { id: "cost", position: { x: 500, y: 340 }, data: { title: "3 Cost cap", sub: "token + money budget" } },
];
const E = (id, source, sourceHandle, target, targetHandle, label) => ({ id, source, sourceHandle, target, targetHandle, label });
export const EDGES = [
  E("e-token", "token", "b-s", "agent", "t-t", "short-lived token"),
  E("e-call", "agent", "r-s", "revoke", "l-t", "call + token"),
  E("e-rev-rate", "revoke", "r-s", "rate", "l-t", "passed"),
  E("e-rate-cost", "rate", "b-s", "cost", "t-t", "passed"),
  E("e-cost-tools", "cost", "l-s", "tools", "r-t", "allow"),
  E("e-kill-token", "kill", "l-s", "token", "r-t", "revoke"),
  E("e-kill-rev", "kill", "b-s", "revoke", "t-t", "state flag"),
  E("e-trip-rate", "rate", "t-s", "kill", "r-t", "trip"),
  E("e-trip-cost", "cost", "r-s", "kill", "r-t", "trip"),
  E("e-kill-audit", "kill", "t-s", "audit", "t-t", "record"),
];
const SIDES = { t: Position.Top, b: Position.Bottom, l: Position.Left, r: Position.Right };

function Box({ data }) {
  return (
    <div className={`fbox${data.on ? " on" : ""}${data.dim ? " dim" : ""}${data.bad ? " bad" : ""}`} data-node={data.id}>
      {Object.entries(SIDES).flatMap(([k, pos]) => [
        <Handle key={`${k}s`} id={`${k}-s`} type="source" position={pos} />,
        <Handle key={`${k}t`} id={`${k}-t`} type="target" position={pos} />,
      ])}
      <strong>{data.title}</strong>
      <span>{data.sub}</span>
      {data.count !== undefined && <em>{data.count}</em>}
    </div>
  );
}
const nodeTypes = { box: Box };

export default function Flow({ path, counts = {}, theme, resetKey = 0, caption }) {
  const [moved, setMoved] = useState(START);
  useEffect(() => { setMoved(START); }, [resetKey]);
  const onNodesChange = useCallback((c) => setMoved((n) => applyNodeChanges(c, n)), []);
  const active = path && (path.nodes.length > 0 || path.bad);

  const nodes = useMemo(() => moved.map((n) => ({
    ...n, type: "box",
    ariaLabel: `${n.data.title}: ${n.data.sub}${counts[n.id] !== undefined ? `, ${counts[n.id]}` : ""}. Arrow keys move the box.`,
    data: { ...n.data, id: n.id, count: counts[n.id], on: !!active && path.nodes.includes(n.id) && path.bad !== n.id, bad: !!active && path.bad === n.id, dim: !!active && !path.nodes.includes(n.id) },
  })), [moved, path, counts, active]);
  const edges = useMemo(() => EDGES.map((e) => {
    const on = !!active && path.edges.includes(e.id);
    return { ...e, animated: on, className: on ? "edge-on" : "", markerEnd: { type: MarkerType.ArrowClosed }, type: "default" };
  }), [path, active]);

  return (
    <>
      <div className="flow-wrap" role="group" aria-label="Diagram: token service, kill switch, audit trail, agent, revocation check, rate cap, cost cap and tools. Boxes can be dragged.">
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} colorMode={theme}
          fitView fitViewOptions={{ padding: 0.08 }} nodesConnectable={false} proOptions={{ hideAttribution: true }} minZoom={0.2}>
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <p className="caption" data-testid="flow-caption">{caption}</p>
    </>
  );
}
