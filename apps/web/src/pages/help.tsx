import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { PageIntro, SectionCard } from "../components/ui";
import { helpTopics } from "../help";

export function HelpPage() {
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) {
      const section = document.getElementById(hash.slice(1));
      section?.scrollIntoView?.();
      section?.focus({ preventScroll: true });
    }
  }, [hash]);

  return (
    <div className="page-stack help-page">
      <PageIntro title="How Cassandra works" description="From a clear question to a forecast you can inspect, test and learn from." />
      <SectionCard title="Your first forecast">
        <ol className="help-steps">
          <li><strong>Define an event.</strong> Add a Yes or No question, deadline and resolution rules in <Link to="/events">Events</Link>.</li>
          <li><strong>Run a judgment.</strong> Open the event and request a prediction. Follow its queued and running states.</li>
          <li><strong>Inspect the trace.</strong> Read the probability, sources, model agreement and evidence gaps in <Link to="/judgments">Judgments</Link>.</li>
          <li><strong>Learn after resolution.</strong> Record the outcome on the event. Retrain and review a snapshot in <Link to="/calibration">Calibration</Link>.</li>
        </ol>
        <p className="helper-text">Live predictions and discovery can incur search and model costs. Reading this guide does not start a run.</p>
      </SectionCard>
      <nav className="help-contents" aria-label="Help topics">
        {Object.entries(helpTopics).map(([id, topic]) => <a key={id} href={`#${id}`}>{topic.title}</a>)}
      </nav>
      {Object.entries(helpTopics).map(([id, topic]) => (
        <div key={id} id={id} tabIndex={-1} className="help-topic">
          <SectionCard title={topic.title}>
            <div className="help-copy">
              <p>{topic.intro}</p>
              <dl className="help-definitions">
                {topic.notes.map(([term, description]) => (
                  <div key={term}><dt>{term}</dt><dd>{description}</dd></div>
                ))}
              </dl>
            </div>
          </SectionCard>
        </div>
      ))}
    </div>
  );
}
