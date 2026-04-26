import { cartUrl } from "../lib/adafruitCart";
import type { Project } from "../types";
import PartIcon from "./PartIcon";

interface PartsPanelProps {
  project: Project;
  owned: Record<string, boolean>;
  setOwned: (next: Record<string, boolean>) => void;
}

export default function PartsPanel({ project, owned, setOwned }: PartsPanelProps) {
  const buying = project.parts.filter((p) => !owned[p.id]);
  const total = buying.reduce((s, p) => s + p.price * p.qty, 0);
  const allOwned = buying.length === 0;

  return (
    <div className="panel flex-natural">
      <div className="panel-head">
        <h3>What you'll need</h3>
        <span className="meta">{project.parts.length} parts</span>
      </div>
      <div className="parts-body">
        <div className="parts-header">
          <span
            className="col-owned"
            style={{ padding: "0px", width: "40px", opacity: 3, color: "rgb(84, 121, 207)" }}
          >
            OWNED
          </span>
          <span className="col-spacer" />
        </div>
        {project.parts.map((p) => (
          <div className={`part ${owned[p.id] ? "owned" : ""}`} key={p.id}>
            <button
              className="part-check"
              title="Check if you already have this"
              onClick={() => setOwned({ ...owned, [p.id]: !owned[p.id] })}
              aria-label={`Mark ${p.name} as owned`}
            >
              ✓
            </button>
            <div className="part-thumb" title={p.name}>
              <PartIcon kind={p.icon} />
            </div>
            <div className="part-info">
              <div className="part-name">{p.name}</div>
              <div className="part-sku">SKU {p.sku}</div>
            </div>
            <span className="part-qty">×{p.qty}</span>
            <span className="part-price">${p.price.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <div className="parts-foot">
        <div className="parts-total">
          {allOwned ? (
            "Got everything"
          ) : (
            <>
              Buying{" "}
              <span>
                {buying.length} of {project.parts.length}
              </span>{" "}
              · <strong>${total.toFixed(2)}</strong>
            </>
          )}
        </div>
        <button
          className="btn-cart"
          disabled={allOwned}
          onClick={() => {
            window.open(cartUrl(project.document), "_blank", "noopener,noreferrer");
          }}
          style={{ backgroundColor: "rgb(250, 250, 250)" }}
        >
          {allOwned ? "Ready to build ✓" : "Buy on Adafruit →"}
        </button>
      </div>
    </div>
  );
}
