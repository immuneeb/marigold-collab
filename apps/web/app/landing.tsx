import Link from "next/link";

// Public, logged-out landing. Explains the product + how to use it so anyone
// arriving here understands it without an account.
export function Landing() {
  return (
    <main className="landing">
      <nav className="landing-nav">
        <span className="wordmark">🌼 Marigold</span>
        <div className="landing-nav-links">
          <a href="#how" className="landing-link">
            How it works
          </a>
          <a href="#draft" className="landing-link">
            Marigold Draft
          </a>
          <Link href="/login" className="btn btn-inline">
            Sign in
          </Link>
        </div>
      </nav>

      <section className="hero">
        <p className="kicker">Google Docs for AI-generated webpages</p>
        <h1 className="hero-h">
          Your assistant builds a page.
          <br />
          Everyone comments on it.
        </h1>
        <p className="lede">
          When you and an AI assistant make something visual — a dashboard, a
          pitch, a report — Marigold hosts it at a private link, lets you share
          it by email, and lets people leave comments pinned to the rendered
          page. The assistant reads the feedback and revises. The comments stay
          put.
        </p>
        <div className="hero-cta">
          <Link href="/login" className="btn btn-inline">
            Get started
          </Link>
          <a href="#how" className="btn-secondary btn-inline">
            See how it works
          </a>
        </div>
      </section>

      <section id="how" className="how">
        <h2 className="section-h">How it works</h2>
        <ol className="steps">
          <li>
            <span className="step-n">1</span>
            <div>
              <strong>Connect your assistant, once.</strong>
              <p className="muted">
                Add Marigold's MCP server to Claude (or any MCP client) and
                authorize with Google a single time. Now your assistant can
                publish docs on your behalf — no copy-paste.
              </p>
            </div>
          </li>
          <li>
            <span className="step-n">2</span>
            <div>
              <strong>Publish a page instantly.</strong>
              <p className="muted">
                Ask your assistant to make something. It returns a private URL,
                and the interactive HTML renders in a fully isolated, sandboxed
                origin — safe to open, even though it's generated code.
              </p>
            </div>
          </li>
          <li>
            <span className="step-n">3</span>
            <div>
              <strong>Share and comment inline.</strong>
              <p className="muted">
                Invite people by email — even if they've never used Marigold.
                They sign in and drop comments pinned to specific elements on the
                live page, like Google Docs, but for a rendered app.
              </p>
            </div>
          </li>
          <li>
            <span className="step-n">4</span>
            <div>
              <strong>Close the loop.</strong>
              <p className="muted">
                Your assistant reads the comments back through MCP, revises the
                doc, and the comments re-anchor onto the new version. Feedback
                is never silently lost.
              </p>
            </div>
          </li>
        </ol>
      </section>

      <section id="draft" className="how">
        <h2 className="section-h">Start local with Marigold Draft</h2>
        <p
          className="muted"
          style={{ maxWidth: 640, margin: "0 auto 24px", textAlign: "center" }}
        >
          The same review loop, running entirely on your machine — free, no
          account. Your coding agent drafts a page, you comment and edit it in
          the browser, and your feedback flows straight back to the agent for
          the next revision. Give this prompt to your coding agent:
        </p>
        <pre
          style={{
            maxWidth: 640,
            margin: "0 auto",
            padding: "16px 18px",
            background: "var(--card)",
            border: "1px solid var(--line)",
            borderRadius: 12,
            whiteSpace: "pre-wrap",
            font: "13.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace",
            userSelect: "all",
          }}
        >
          Install Marigold Draft for me using `npm i -g marigold-draft`, then
          read https://marigold-collab-web.vercel.app/draft/setup.md and set
          yourself up to use it.
        </pre>
        <p className="muted small" style={{ textAlign: "center", marginTop: 14 }}>
          Or yourself: <code>npm i -g marigold-draft</code> then{" "}
          <code>marigold-draft agent-setup</code> · when a draft is ready to
          share, the same HTML publishes here unchanged.
        </p>
      </section>

      <section className="actors">
        <div className="actor-card">
          <div className="actor-emoji">🧑‍💼</div>
          <strong>You (the owner)</strong>
          <p className="muted small">
            Publish via your assistant, review, comment, and share with specific
            people at viewer / commenter / editor roles.
          </p>
        </div>
        <div className="actor-card">
          <div className="actor-emoji">👥</div>
          <strong>Your collaborators</strong>
          <p className="muted small">
            Get an email invite, sign in with Google, and see everything shared
            with them — commenting right on the rendered page.
          </p>
        </div>
        <div className="actor-card">
          <div className="actor-emoji">🤖</div>
          <strong>The AI assistant</strong>
          <p className="muted small">
            Creates and updates docs and reads the human feedback — acting on
            your behalf through the MCP connection.
          </p>
        </div>
      </section>

      <section className="cta-band">
        <h2 className="section-h">Ready to try it?</h2>
        <p className="muted">Sign in and publish your first doc in a minute.</p>
        <Link href="/login" className="btn btn-inline">
          Sign in with Google
        </Link>
      </section>

      <footer className="landing-foot">
        <span>🌼 Marigold</span>
        <span className="muted small">
          MCP endpoint: <code>/api/mcp</code> · docs render in an isolated,
          sandboxed origin
        </span>
      </footer>
    </main>
  );
}
