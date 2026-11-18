import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  TangentChildren,
  type TangentChildView,
  type WorkerChildView,
} from "../../src/client/tangents/children";
import "../../src/client/index.css";

const tangents: TangentChildView[] = [
  {
    id: "running",
    parentId: "main",
    title: "Running task",
    model: "Model Alpha",
    lifecycle: "open",
    activity: "running",
    attention: "needs-input",
  },
  {
    id: "idle",
    parentId: "main",
    title: "Idle task",
    model: "Model Beta",
    lifecycle: "open",
    activity: "idle",
    attention: "none",
  },
  {
    id: "waiting",
    parentId: "main",
    title: "Waiting task",
    model: "Model Gamma",
    lifecycle: "open",
    activity: "waiting",
    attention: "none",
  },
  {
    id: "failed",
    parentId: "main",
    title: "Failed task",
    model: "Model Delta",
    lifecycle: "open",
    activity: "failed",
    attention: "none",
  },
  {
    id: "other",
    parentId: "elsewhere",
    title: "Other task",
    model: "Other model",
    lifecycle: "open",
    activity: "running",
    attention: "none",
  },
  {
    id: "finished",
    parentId: "main",
    title: "Concluded task",
    model: "Old model",
    lifecycle: "concluded",
    activity: "idle",
    attention: "none",
  },
];
const workers: WorkerChildView[] = [
  {
    id: "w2",
    parentId: "main",
    title: "Worker two",
    model: "Model Two",
    lifecycle: "open",
    activity: "failed",
    attention: "none",
  },
  {
    id: "w3",
    parentId: "running",
    title: "Tangent worker",
    model: "Model Three",
    lifecycle: "open",
    activity: "running",
    attention: "needs-input",
  },
  {
    id: "w1",
    parentId: "main",
    title: "Worker one",
    model: "Model One",
    lifecycle: "open",
    activity: "idle",
    attention: "needs-input",
  },
];

function Fixture() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <>
      <div data-testid="main">
        <TangentChildren
          parentId="main"
          tangents={tangents}
          workers={workers}
          selectedTangentId={selected}
          onSelectTangent={setSelected}
        />
      </div>
      <div data-testid="tangent">
        <TangentChildren
          parentId="running"
          tangents={tangents}
          workers={workers}
          selectedTangentId={null}
          onSelectTangent={setSelected}
        />
      </div>
      <div data-testid="empty">
        <TangentChildren
          parentId="empty"
          tangents={tangents}
          workers={workers}
          selectedTangentId={null}
          onSelectTangent={setSelected}
        />
      </div>
      <output data-testid="selected">{selected}</output>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
