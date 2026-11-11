import { Link } from "react-router-dom";
import { helpTopics, type HelpTopic } from "../help";

export function ContextHelp({ topic }: { topic: HelpTopic }) {
  const help = helpTopics[topic];
  return (
    <details className="disclosure context-help">
      <summary>{help.summary}</summary>
      <div className="disclosure__body help-copy">
        <p>{help.intro}</p>
        <Link to={`/help#${topic}`}>{help.guideLabel} <span aria-hidden="true">→</span></Link>
      </div>
    </details>
  );
}
