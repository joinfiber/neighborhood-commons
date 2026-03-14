import { styles, colors } from '../lib/styles';

interface TermsScreenProps {
  onBack: () => void;
}

export function TermsScreen({ onBack }: TermsScreenProps) {
  return (
    <div style={styles.page}>
      <div style={styles.content} className="fade-up">

        {/* Back nav */}
        <button
          type="button"
          onClick={onBack}
          style={{ ...styles.buttonText, marginBottom: '16px' }}
        >
          ← Back
        </button>

        <h1 style={{
          fontSize: '28px',
          fontWeight: 300,
          color: colors.cream,
          letterSpacing: '0.04em',
          margin: '0 0 8px 0',
        }}>
          Terms of Use
        </h1>
        <p style={{
          fontSize: '13px',
          color: colors.dim,
          margin: '0 0 32px 0',
        }}>
          Last updated: March 14, 2026
        </p>

        {/* ---- Intro ---- */}
        <Section>
          <P>
            Neighborhood Commons is a community bulletin board for the neighborhood. Businesses, venues, nonprofits, and community organizations use it to post events — and every app in the area can show them.
          </P>
          <P>
            We believe neighborhoods thrive when people know what's happening nearby. We believe in shared prosperity — a rising tide for the local businesses and organizations that make a place worth living in. This project exists to serve that mission.
          </P>
          <P>
            These terms are how we keep the board useful for everyone. They're short, plain-language, and mean what they say.
          </P>
        </Section>

        {/* ---- Who this is for ---- */}
        <Heading>Who can use the portal</Heading>
        <Section>
          <P>
            Portal accounts are for businesses, venues, nonprofits, and community organizations that host events open to the public in their neighborhood. Think: a coffee shop posting open mic night, a yoga studio listing classes, a community garden announcing a volunteer day.
          </P>
          <P>
            The portal is not for individuals posting personal events. If you want to share something with friends or your social circle, that belongs in an app with a social layer — not here.
          </P>
        </Section>

        {/* ---- Curation ---- */}
        <Heading>We curate this feed</Heading>
        <Section>
          <P>
            Every account goes through a review. We check that you're a real organization hosting real events in the neighborhood. This isn't a formality — it's how we keep the Commons useful.
          </P>
          <P>
            We reserve the right to approve, decline, or remove any account or listing at our discretion. This isn't about taste — we're not here to judge your business. It's about keeping the board focused on its purpose: helping neighbors discover what's happening nearby.
          </P>
          <P>
            If your account or event is removed, we'll tell you why when we can.
          </P>
        </Section>

        {/* ---- Your content ---- */}
        <Heading>Your content</Heading>
        <Section>
          <P>
            You own what you post. You can edit or remove your events at any time, and we will honor that immediately across the system.
          </P>
          <P>
            By posting, you grant a <strong style={{ color: colors.cream }}>Creative Commons Attribution 4.0 (CC BY 4.0)</strong> license on your event data. That means other apps and services can display your events with attribution. This is the whole point — post once, reach everyone.
          </P>
          <P>
            You're responsible for the accuracy of what you post. Don't post events that don't exist, list misleading times or locations, or use the portal to promote something other than real happenings.
          </P>
        </Section>

        {/* ---- No guaranteed distribution ---- */}
        <Heading>No guaranteed distribution</Heading>
        <Section>
          <P>
            Publishing an event to the Commons makes it available in our public data feed. But appearing in the feed doesn't guarantee anyone sees it.
          </P>
          <P>
            Apps that use this data make their own decisions about what to display and how to rank it. Users in those apps can block accounts they don't want to see — and those blocks reduce your reach across the board. If people find your posts spammy or low-quality, they'll block you, and your future events won't reach them — including the ones they'd actually want to attend.
          </P>
          <P>
            The best way to reach the neighborhood is to post things the neighborhood actually wants to know about.
          </P>
        </Section>

        {/* ---- Acceptable use ---- */}
        <Heading>Acceptable use</Heading>
        <Section>
          <P>Don't use the portal to:</P>
          <ul style={{ margin: '0 0 16px 0', padding: '0 0 0 20px', color: colors.text, fontSize: '14px', lineHeight: 1.7 }}>
            <li>Post events that aren't real or are intentionally misleading</li>
            <li>Harass, target, or disparage other people or businesses</li>
            <li>Circumvent moderation on other platforms by routing through the Commons</li>
            <li>Post content unrelated to events or happenings (ads, political messaging, personal grievances)</li>
            <li>Create multiple accounts to evade a previous removal</li>
          </ul>
          <P>
            We're not looking for reasons to remove people. But if your use of the portal makes the Commons worse for the neighborhood, we'll act.
          </P>
        </Section>

        {/* ---- Free forever ---- */}
        <Heading>Free to post</Heading>
        <Section>
          <P>
            There is no fee to create an account, post events, or maintain your listings. Free now, free forever. That's a pricing commitment — we will never charge businesses to post their events.
          </P>
        </Section>

        {/* ---- Account termination ---- */}
        <Heading>Account suspension and termination</Heading>
        <Section>
          <P>
            We may suspend or terminate accounts that violate these terms, that we determine are not legitimate business or organization accounts, or that otherwise undermine the mission of the Commons. We'll explain our reasoning when possible.
          </P>
          <P>
            You can delete your account at any time by contacting us at <a href="mailto:hello@joinfiber.app" style={{ color: colors.muted, textDecoration: 'underline' }}>hello@joinfiber.app</a>. We'll remove your account and all associated event data.
          </P>
        </Section>

        {/* ---- The open part ---- */}
        <Heading>The data is open. So is the spec.</Heading>
        <Section>
          <P>
            The event data in the Commons is published under CC BY 4.0. The API is free and requires no authentication to read. Anyone can build on it.
          </P>
          <P>
            The <a href="https://github.com/The-Relational-Technology-Project/neighborhood-api" style={{ color: colors.muted, textDecoration: 'underline' }} target="_blank" rel="noopener noreferrer">Neighborhood API spec</a> is MIT-licensed and designed for interoperability. If you disagree with how we curate this feed, you are welcome and encouraged to run your own. Fork the repo, stand up your own Commons, set your own rules. The spec exists so that no single operator — including us — is a bottleneck for neighborhood data.
          </P>
          <P>
            We mean this sincerely. A diversity of feeds, each with their own editorial perspective, is better for neighborhoods than one feed that tries to please everyone.
          </P>
        </Section>

        {/* ---- Changes ---- */}
        <Heading>Changes to these terms</Heading>
        <Section>
          <P>
            We may update these terms as the project evolves. When we do, we'll update the date at the top of this page. Continued use of the portal after changes constitutes acceptance.
          </P>
          <P>
            Questions? <a href="mailto:hello@joinfiber.app" style={{ color: colors.muted, textDecoration: 'underline' }}>hello@joinfiber.app</a>
          </P>
        </Section>

        <div style={{ height: '60px' }} />
      </div>
    </div>
  );
}

// -- Simple typography helpers --

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{
      fontSize: '16px',
      fontWeight: 500,
      color: colors.cream,
      margin: '32px 0 12px 0',
    }}>
      {children}
    </h2>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return <div style={{ marginBottom: '8px' }}>{children}</div>;
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p style={{
      fontSize: '14px',
      lineHeight: 1.7,
      color: colors.text,
      margin: '0 0 12px 0',
    }}>
      {children}
    </p>
  );
}
