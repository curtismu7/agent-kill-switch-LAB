import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, BackgroundVariant, BaseEdge, Controls, EdgeLabelRenderer, getBezierPath, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useUpdateNodeInternals } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { STEP_TIME_OPTIONS, useStepper } from "../hooks/useStepper.js";

// The diagram is diagram-studio/1 data loaded by name from /api/fedid/diagram: no node or edge is written here. Boxes move with the mouse;
// Simulate walks the arrows in order (speed is the step time); Reset puts every box back and stops the walkthrough.
// At phone width fitting the whole wide diagram makes the text unreadable, so the view is held at 0.5 on the first boxes (node text is larger in
// fedid.css); drag the background to pan, drag a box to move it.
const narrow = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 600px)").matches;
const HANDLES = [["t", Position.Top], ["b", Position.Bottom], ["l", Position.Left], ["r", Position.Right]];

function Box({ data }) {
  return (
    <div className="fedid-node" data-color={data.color} data-on={data.on ? "true" : "false"} data-testid={`fedid-node-${data.id}`}>
      {HANDLES.map(([k, pos]) => (
        <span key={k}>
          <Handle id={`s-${k}`} type="source" position={pos} className="fedid-node__handle" />
          <Handle id={`t-${k}`} type="target" position={pos} className="fedid-node__handle" />
        </span>
      ))}
      {data.label}
    </div>
  );
}

// An edge that draws its own label, so a reply along the same pair of boxes can sit above or below its partner.
function LabelEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }) {
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div className="fedid-elabel" data-now={data.now ? "true" : "false"} data-dim={data.dim ? "true" : "false"} data-testid="fedid-edge-label"
          style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly + data.dy}px)` }}>{data.text}</div>
      </EdgeLabelRenderer>
    </>
  );
}
const nodeTypes = { box: Box };
const edgeTypes = { label: LabelEdge };

// Steps that run along the same pair of boxes in opposite directions get opposite nudges.
export function labelOffsets(steps) {
  return steps.map((s, i) => {
    if (steps.slice(0, i).some((o) => o.from === s.to && o.to === s.from)) return 18;
    return steps.slice(i + 1).some((o) => o.from === s.to && o.to === s.from) ? -18 : 0;
  });
}
const sides = (a, b) => {
  const dx = b.x - a.x; const dy = b.y - a.y;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? ["r", "l"] : ["l", "r"]) : (dy > 0 ? ["b", "t"] : ["t", "b"]);
};

function Canvas({ pattern, positions, onMove, stepper, theme, fitKey }) {
  const active = stepper.step >= 0 ? pattern.steps[stepper.step] : null;
  const fit = useMemo(() => (narrow() ? { padding: 0.1, minZoom: 0.5, maxZoom: 0.5, nodes: pattern.nodes.slice(0, 2).map((n) => ({ id: n.id })) } : { padding: 0.08 }), [pattern]);
  // On a slow or busy machine the first measurement of the boxes can miss their handles and no arrow is drawn: measure again shortly after mounting.
  const updateInternals = useUpdateNodeInternals();
  useEffect(() => {
    const ids = pattern.nodes.map((n) => n.id);
    const timers = [60, 400, 1500].map((ms) => setTimeout(() => updateInternals(ids), ms));
    return () => timers.forEach(clearTimeout);
  }, [pattern, fitKey, updateInternals]);
  const nodes = pattern.nodes.map((n) => ({ id: n.id, type: "box", position: positions[n.id], draggable: true, data: { id: n.id, label: n.label, color: n.color, on: !!active && (active.from === n.id || active.to === n.id) } }));
  const offs = labelOffsets(pattern.steps);
  const edges = pattern.steps.map((s, i) => {
    const [a, b] = sides(positions[s.from], positions[s.to]);
    const now = stepper.step === i;
    const seen = stepper.step >= 0 && i <= stepper.step;
    return {
      id: `e${i}`, source: s.from, target: s.to, sourceHandle: `s-${a}`, targetHandle: `t-${b}`, type: "label", animated: now,
      data: { text: `${i + 1}. ${s.edge || s.label}`, dy: offs[i], now, dim: stepper.step >= 0 && !seen },
      className: `fedid-edge${now ? " fedid-edge--now" : ""}${stepper.step >= 0 && !seen ? " fedid-edge--dim" : ""}${s.dashed ? " fedid-edge--dashed" : ""}`,
      markerEnd: { type: MarkerType.ArrowClosed },
    };
  });
  return (
    <div className="fedid-canvas" data-testid="fedid-canvas">
      <ReactFlow key={fitKey} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} colorMode={theme} fitView fitViewOptions={fit} nodesConnectable={false}
        nodesFocusable={false} edgesFocusable={false} minZoom={0.2} proOptions={{ hideAttribution: true }}
        onNodeDrag={(_, n) => onMove(n.id, n.position)} onNodeDragStop={(_, n) => onMove(n.id, n.position)}>
        <Background variant={BackgroundVariant.Dots} gap={18} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

export default function FedIdDiagram({ pattern, theme, resetSignal = 0 }) {
  const initial = useMemo(() => Object.fromEntries(pattern.nodes.map((n) => [n.id, { x: n.x, y: n.y }])), [pattern]);
  const [positions, setPositions] = useState(initial);
  const [fitKey, setFitKey] = useState(0);
  const stepper = useStepper(pattern.steps.length);
  const onMove = useCallback((id, p) => setPositions((cur) => ({ ...cur, [id]: { x: p.x, y: p.y } })), []);
  const { stop } = stepper;
  // Reset restores every box, stops the walkthrough and refits the view. The page-level Reset raises resetSignal.
  const reset = useCallback(() => { stop(); setPositions(initial); setFitKey((k) => k + 1); }, [stop, initial]);
  const seen = useRef(resetSignal);
  useEffect(() => { if (seen.current !== resetSignal) { seen.current = resetSignal; reset(); } }, [resetSignal, reset]);
  const step = stepper.step >= 0 ? pattern.steps[stepper.step] : null;
  const moved = Object.keys(positions).filter((k) => positions[k].x !== initial[k].x || positions[k].y !== initial[k].y).length;
  return (
    <section className="fedid-diagram" aria-labelledby="fedid-diagram-h" data-testid="fedid-diagram">
      <h3 id="fedid-diagram-h">{pattern.title}</h3>
      <div className="fedid-stepbar" data-testid="fedid-stepbar">
        <label>Step time
          <select value={stepper.stepMs} onChange={(e) => stepper.setStepMs(Number(e.target.value))} disabled={stepper.active && !stepper.paused} data-testid="fedid-speed">
            {STEP_TIME_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        {!stepper.active ? <button type="button" className="btn" onClick={stepper.simulate} data-testid="fedid-simulate">Simulate</button> : (
          <>
            <button type="button" className="btn" onClick={stepper.prev} disabled={!stepper.paused}>Prev</button>
            {stepper.paused ? <button type="button" className="btn" onClick={stepper.resume}>Resume</button> : <button type="button" className="btn" onClick={stepper.pause}>Pause</button>}
            <button type="button" className="btn" onClick={stepper.next} disabled={!stepper.paused}>Next</button>
            <button type="button" className="btn" onClick={stepper.stop}>Stop</button>
          </>
        )}
        <button type="button" className="btn" onClick={reset} data-testid="fedid-diagram-reset">Reset boxes and walkthrough</button>
      </div>
      <p className="fedid-step" aria-live="polite" data-testid="fedid-step">
        {step ? <><strong>Step {stepper.step + 1} of {stepper.total}: {step.label}.</strong> {step.say}</> : `Simulate walks the ${stepper.total} arrows in order. Drag any box to rearrange; drag the background to pan.`}
      </p>
      <ReactFlowProvider>
        <Canvas pattern={pattern} positions={positions} onMove={onMove} stepper={stepper} theme={theme} fitKey={fitKey} />
      </ReactFlowProvider>
      <p className="hint">Moved boxes: <span data-testid="fedid-moved">{moved}</span>. Simulated; the host names are examples.</p>
    </section>
  );
}
