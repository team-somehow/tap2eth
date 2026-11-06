import { useRef } from 'react';
import Stage from './Stage.jsx';

const GITHUB = 'https://github.com/team-somehow/ethglobal-mumbai';
const WHITEPAPER = `${GITHUB}/blob/main/docs/WHITEPAPER.md`;
const PROTOCOL = `${GITHUB}/blob/main/docs/PROTOCOL.md`;
const DEMO = 'https://youtu.be/yceDX-JkmSc';
const WC = 'https://explorer.testnet.whitechain.io';
const ARC = 'https://explorer.testnet.arc.io';

function Ext({ href, className, children }) {
  return <a className={className} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

function Logo() {
  return (
    <svg viewBox="0 0 34 24" aria-hidden="true">
      <rect x="1" y="1" width="32" height="22" rx="5" fill="#FFE600" stroke="currentColor" strokeWidth="2" />
      <rect x="6" y="8" width="6" height="7" rx="1.5" fill="#11120F" />
      <path d="M19 8c2 2 2 6 0 8m4-10c3 3 3 9 0 12" fill="none" stroke="#11120F" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function Arrow({ down = false }) {
  return <svg className={down ? 'arrow down' : 'arrow'} viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function Nav() {
  return (
    <header className="nav">
      <a className="brand" href="#top" aria-label="Tap2ETH home"><Logo />Tap2ETH</a>
      <nav className="nav-links" aria-label="Main navigation">
        <a href="#demo">Demo</a>
        <a href="#how">How it works</a>
        <a href="#proof">The proof</a>
      </nav>
      <Ext className="nav-source" href={GITHUB}>View source <Arrow /></Ext>
    </header>
  );
}

function Hero({ stageRef }) {
  return (
    <section className="hero" id="top" data-station="hero" data-anchor="start">
      <div className="hero-orbit" aria-hidden="true" />
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <span className="eyebrow"><span className="status-dot" />A new use for the card you know</span>
          <h1>Your bank card.<br />Now your<br /><span className="highlight">crypto wallet.</span></h1>
          <p className="lede">Tap the card you already carry. Approve on your phone. Pay in stablecoins.</p>
          <div className="cta-row">
            <a className="btn btn-ink" href="#demo">Watch the demo <Arrow down /></a>
            <Ext className="text-link" href={WHITEPAPER}>Read the whitepaper <Arrow /></Ext>
          </div>
          <p className="hero-note">No seed phrase. No extra card. Just a tap.</p>
        </div>
        <div className="hero-stage" ref={stageRef}>
          <div className="fallback-card" aria-hidden="true"><span>YOUR BANK</span><i /><b>•••• &nbsp; •••• &nbsp; 4821</b><em>tap.</em></div>
          <span className="visual-index" aria-hidden="true">An ordinary card.<br />An extraordinary second act.</span>
          <p className="drag-hint">Drag to explore <span aria-hidden="true">↔</span></p>
        </div>
      </div>
      <div className="wrap hero-bottom">
        <span>Built at <strong>ETHGlobal Mumbai ’26</strong></span>
        <span className="availability"><span className="status-dot" />Testnet demo <i /> Android <i /> Mastercard tested</span>
      </div>
    </section>
  );
}

function Demo() {
  return (
    <section className="section demo" id="demo" aria-labelledby="demo-title" data-station="gone2" data-anchor="top">
      <div className="wrap">
        <div className="section-head">
          <div><span className="eyebrow">The demo</span><h2 id="demo-title">See it in action.</h2></div>
          <Ext className="text-link" href={DEMO}>Watch on YouTube <Arrow /></Ext>
        </div>
        <div className="demo-frame">
          <iframe
            src="https://www.youtube-nocookie.com/embed/yceDX-JkmSc?rel=0"
            title="Tap2ETH demo — ETHGlobal Mumbai 2026"
            loading="lazy"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        </div>
      </div>
    </section>
  );
}

function Step({ station, number, title, body, children }) {
  return (
    <article className="step" data-station={station}>
      <div className="wrap">
        <div className="step-copy">
          <span className="step-no">{number} <span>/ 03</span></span>
          <h3>{title}</h3>
          <p>{body}</p>
          {children}
        </div>
      </div>
    </article>
  );
}

function HowItWorks() {
  return (
    <section className="story" id="how">
      <div className="wrap story-intro">
        <span className="eyebrow">Familiar on the outside. Powerful inside.</span>
        <h2>One card.<br />Three simple steps.</h2>
        <p>Your card already has a signing key.<br />We give it a new job.</p>
      </div>
      <Step station="tap2" number="01" title={<>Tap your card.<br />Wake up the chip.</>} body="The reader powers the chip wirelessly. No battery, no pairing. The same contactless tap you already know.">
        <span className="step-tag">Your existing contactless card</span>
      </Step>
      <Step station="secret2" number="02" title={<>Your card signs.<br />Your key stays put.</>} body="The chip signs a fresh challenge. Its private key stays inside the card; only the signature comes out.">
        <div className="signature-flow" aria-label="Challenge goes into the card, signature comes out"><span>Challenge</span><Arrow /><span className="flow-chip">Chip</span><Arrow /><span>Signature</span></div>
      </Step>
      <Step station="pay2" number="03" title={<>Your phone approves.<br />Your wallet pays.</>} body="Confirm with your fingerprint. The smart wallet checks both signatures, then sends the stablecoins. The relayer covers gas.">
        <span className="step-tag"><span className="status-dot" />Card + phone. Both by default.</span>
      </Step>
    </section>
  );
}

const RECEIPTS = [
  { amount: '0.3', token: 'USDT', network: 'Whitechain Sepolia', title: 'Sent with a real card + fingerprint.', href: `${WC}/tx/0x31945fb2ff21ecd3f123011690a0481a6f8fcf0f0a46db9fb27fd2a84e7d2eea` },
  { amount: '12', token: 'tUSDC', network: 'Terminal demo', title: 'Tapped at our terminal. Settled on-chain.' },
  { amount: '0.01', token: 'USDC', network: 'Arc testnet', title: 'Same card. Same flow. Another chain.', href: `${ARC}/tx/0x7cbb741be0aa18738188bc204898fba6707c22557bcabd51e148e4d478002c8b` },
];

function Proof() {
  return (
    <section className="section proof" id="proof" data-station="gone1" data-anchor="top">
      <div className="wrap">
        <div className="section-head">
          <div><span className="eyebrow">Real cards. Real transactions.</span><h2>Less promise.<br />More proof.</h2></div>
          <p>Tested with our own bank cards,<br className="desktop-break" /> phones, and a terminal we built.</p>
        </div>
        <div className="receipts">
          {RECEIPTS.map((r, i) => (
            <article className="receipt" key={r.network}>
              <div className="receipt-meta"><span>{r.network}</span><span>0{i + 1}</span></div>
              <p className="receipt-amount">{r.amount}<span>{r.token}</span></p>
              <h3>{r.title}</h3>
              <div className="receipt-bottom"><span className="settled"><span className="status-dot" />Settled</span>{r.href ? <Ext href={r.href}>View transaction <Arrow /></Ext> : <span className="demo-label">6 Nov 2026</span>}</div>
            </article>
          ))}
        </div>
        <div className="verification">
          <span className="verification-label">Behind the demo</span>
          <p><strong>36/36</strong> live contract checks</p>
          <p><strong>54/54</strong> local checks, including recovery</p>
          <span className="verification-note">Automated checks use generated test cards.</span>
        </div>
      </div>
    </section>
  );
}

const FEATURES = [
  { icon: 'limits', title: 'Set the limits.', body: 'Daily and per-payment limits, enforced on-chain.' },
  { icon: 'freeze', title: 'Freeze in a tap.', body: 'Lost your card? Freeze the wallet from your phone.' },
  { icon: 'keys', title: 'Make it yours.', body: 'Add cards or phones. Choose how many must sign.' },
];

function FeatureIcon({ type }) {
  return <svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{type === 'limits' ? <><path d="M5 9h22M5 23h22M11 5v8m10 6v8" /><circle cx="11" cy="9" r="3" fill="var(--paper)" /><circle cx="21" cy="23" r="3" fill="var(--paper)" /></> : type === 'freeze' ? <><path d="M16 3v26M5 9l22 14M5 23 27 9M12 6l4 4 4-4m-8 20 4-4 4 4M5 14l5-1-1-5m18 10-5 1 1 5M5 18l5 1-1 5m18-10-5-1 1-5" /></> : <><rect x="3" y="8" width="20" height="14" rx="3" /><path d="M10 8V5h17a2 2 0 0 1 2 2v12h-6M7 14h4m6 3h2" /></>}</svg>;
}

function Wallet() {
  return (
    <section className="section wallet" id="wallet">
      <div className="wrap">
        <div className="wallet-heading"><span className="eyebrow">Familiar tap. More control.</span><h2>Your money.<br />Your ground rules.</h2></div>
        <div className="features">{FEATURES.map(f => <article className="feature" key={f.title}><FeatureIcon type={f.icon} /><h3>{f.title}</h3><p>{f.body}</p></article>)}</div>
      </div>
    </section>
  );
}

function Details() {
  return (
    <section className="section details" id="details">
      <div className="wrap details-grid">
        <div>
          <span className="eyebrow">The open protocol</span>
          <h2>A little deeper.</h2>
          <nav className="protocol-links" aria-label="Protocol resources">
            <Ext className="text-link" href={WHITEPAPER}>Read the whitepaper <Arrow /></Ext>
            <Ext className="text-link" href={PROTOCOL}>Protocol specification <Arrow /></Ext>
            <Ext className="text-link" href={GITHUB}>Protocol repository <Arrow /></Ext>
          </nav>
        </div>
        <div className="accordions">
          <details><summary>What does the card actually sign?<span aria-hidden="true" /></summary><div className="detail-body"><p>The card signs 4 bytes of the payment hash using EMV dynamic data authentication. Your phone signs the full 32-byte hash, binding the recipient, amount, and payment details.</p><p>The bank originally provisioned the card key. The phone adds an independent approval; the contract checks both signatures.</p></div></details>
          <details><summary>What works today?<span aria-hidden="true" /></summary><div className="detail-body"><p>Android, tested with Mastercard on Whitechain Sepolia and Arc testnet. Visa is not yet verified. Cards must support dynamic authentication.</p><p>Card-only small payments are optional and off by default. Lost-phone recovery uses two cards and a time lock; it is demo-strength and has not yet been tested in the phone app. A stronger recovery version is written but not deployed.</p><p>A reissued card has a new key; card replacement also uses a time lock. This is testnet software with legacy-grade card keys.</p></div></details>
          <details><summary>Can I inspect the contracts?<span aria-hidden="true" /></summary><div className="detail-body"><p>Open source, with verified deployments:</p><Ext className="contract-link" href={`${WC}/address/0xb413D6AA35c3901Bac6D441e8f1b38640416557A#code`}>Whitechain wallet factory <Arrow /></Ext><Ext className="contract-link" href={`${WC}/address/0x75572741C89B0665fB3A30473B831f0e83153b88#code`}>Whitechain wallet implementation <Arrow /></Ext><Ext className="contract-link" href={`${ARC}/address/0xd7783c67607704a19018015E184fFd008392A363?tab=contract`}>Arc contract <Arrow /></Ext></div></details>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <>
      <section className="outro">
        <div className="wrap"><span className="eyebrow">Open source. Built in Mumbai.</span><h2>The next wallet<br />is already in your pocket.</h2><Ext className="btn btn-ink" href={GITHUB}>Build with Tap2ETH <Arrow /></Ext><span className="outro-mark" aria-hidden="true"><Logo /></span></div>
      </section>
      <footer><div className="wrap"><a className="brand" href="#top"><Logo />Tap2ETH</a><span>Made by team-somehow · ETHGlobal Mumbai 2026</span><nav className="footer-links" aria-label="Footer"><Ext href={WHITEPAPER}>Whitepaper ↗</Ext><Ext href={GITHUB}>Protocol repo ↗</Ext></nav><small>Testnet demo. Not affiliated with Visa or Mastercard.</small></div></footer>
    </>
  );
}

export default function App() {
  const heroStageRef = useRef(null);
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <Nav />
      <Stage heroStageRef={heroStageRef} />
      <main id="main">
        <Hero stageRef={heroStageRef} />
        <Demo />
        <HowItWorks />
        <Proof />
        <Wallet />
        <Details />
      </main>
      <Footer />
    </>
  );
}
