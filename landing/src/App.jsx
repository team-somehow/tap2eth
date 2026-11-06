import { useRef } from 'react';
import Stage from './Stage.jsx';
import { useScrollProgress } from './useScrollProgress.js';

const GITHUB = 'https://github.com/team-somehow/ethglobal-mumbai';
const WC = 'https://explorer.testnet.whitechain.io';
const ARC = 'https://explorer.testnet.arc.io';

/* ---------------------------------------------------------------- small pieces */

function Ext({ href, className, children }) {
  return <a className={className} href={href} target="_blank" rel="noopener">{children}</a>;
}

function Logo() {
  return (
    <svg viewBox="0 0 34 24" aria-hidden="true">
      <rect x="1" y="1" width="32" height="22" rx="4" fill="#FFE600" stroke="#0A0A0A" strokeWidth="2" />
      <rect x="5" y="8" width="7" height="6" rx="1.5" fill="#0A0A0A" />
      <path d="M19 7.5c2 2.2 2 6.8 0 9M23 5.5c3 3.3 3 9.7 0 13" fill="none" stroke="#0A0A0A" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function Tick({ color = '#0A0A0A' }) {
  return (
    <span className="tick">
      <svg viewBox="0 0 12 12"><path d="M2 6.5l2.5 2.5L10 3" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" /></svg>
    </span>
  );
}

/** One scroll step of a chapter: tall block whose centre is a 3D station. */
function Step({ station, no, title, children }) {
  return (
    <div className="step" data-station={station}>
      <div className="wrap">
        <article className="panel reveal">
          <span className="step-no">{no}</span>
          <h3>{title}</h3>
          {children}
        </article>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- hero */

function Nav() {
  return (
    <header className="nav">
      <a className="brand" href="#top" aria-label="Tap2ETH home"><Logo />Tap2ETH</a>
      <ul className="nav-links">
        <li><a href="#how">How a tap works</a></li>
        <li><a href="#secret">The secret</a></li>
        <li><a href="#pay">Payments</a></li>
        <li><a href="#proof">Proof</a></li>
      </ul>
      <Ext className="btn btn-sm btn-yellow" href={GITHUB}>GitHub</Ext>
    </header>
  );
}

function Hero({ stageRef }) {
  return (
    <section className="hero" id="top" data-station="hero" data-anchor="start">
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <span className="eyebrow">Built at ETHGlobal Mumbai 2026</span>
          <h1>The bank card already in your wallet is your <mark>crypto wallet.</mark></h1>
          <p className="lede">
            Tap2ETH turns the contactless bank card you already carry into the key of a self-custodial smart wallet. We've tested it with Mastercard.
            There's no seed phrase, no new hardware and no bank partnership. Tap your card, approve with your
            fingerprint, and stablecoins move on-chain.
          </p>
          <div className="cta-row">
            <a className="btn btn-ink" href="#how">
              See how it works
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v15m0 0l-6-6m6 6l6-6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </a>
            <Ext className="btn" href={GITHUB}>Code on GitHub</Ext>
          </div>
          <dl className="facts">
            <div><dt>Seed phrases</dt><dd>0</dd></div>
            <div><dt>New hardware</dt><dd>None</dd></div>
            <div><dt>Approve with</dt><dd>Card + finger</dd></div>
          </dl>
        </div>
        <div className="hero-stage" id="hero-stage" ref={stageRef}>
          <div className="fallback-card" aria-hidden="true" />
          <p className="drag-hint">Drag to turn the card</p>
        </div>
      </div>
    </section>
  );
}

const STATEMENT = 'Over a billion people already carry a chip card. Inside most modern chips is a private key that can *sign* but can never be *copied* out. Tap2ETH turns that key into the lock on your wallet.';

function Statement() {
  const ref = useRef(null);
  const p = useScrollProgress(ref, { start: 0.85, span: 0.25, heightWeight: 1 });
  const words = STATEMENT.split(/\s+/);
  const lit = Math.round(p * words.length);
  return (
    <section className="statement" data-station="statement">
      <div className="wrap">
        <p ref={ref} className="reveal">
          {words.map((w, i) => {
            const hl = w.includes('*');
            return <span key={i} className={`w${hl ? ' hl' : ''}${i < lit ? ' on' : ''}`}>{w.replace(/\*/g, '')} </span>;
          })}
        </p>
        <div className="statement-meta">
          <span className="chip">ISO/IEC 14443</span><span className="chip">EMV DDA</span><span className="chip">Smart contract wallet</span>
        </div>
      </div>
    </section>
  );
}

const TICKER = ['13.56 MHz carrier', 'ISO/IEC 14443-A', 'SELECT 2PAY.SYS.DDF01', 'AID A0000000041010', 'INTERNAL AUTHENTICATE', 'RSA-1024 · e = 3', 'SHA-1', 'P-256 passkey', 'keccak256', 'modexp precompile', 'Whitechain Sepolia', 'Arc testnet'];

function Ticker() {
  return (
    <div className="ticker" aria-hidden="true">
      <div className="ticker-track">{[...TICKER, ...TICKER].map((t, i) => <span key={i}>{t}</span>)}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- chapter 1: RFID */

const APDU = [
  ['tx', '00 A4 04 00 0E 32 50 41 59 2E 53 59 53 2E 44 44 46 30 31 00', 'Select the payment directory "2PAY.SYS.DDF01"'],
  ['rx', '6F … 4F 07 A0 00 00 00 04 10 10 … 90 00', 'The card lists its payment app'],
  ['tx', '00 A4 04 00 07 A0 00 00 00 04 10 10 00', 'Open the Mastercard app'],
  ['tx', '80 A8 00 00 … 83 …', 'Get processing options'],
  ['tx', '00 B2 01 0C 00', "Read records: the card's certificates"],
  ['tx', '00 88 00 00 04 7F 3A 9C 21 00', 'Internal authenticate: sign these 4 bytes'],
  ['rx', '80 81 80 3B 9E 51 C4 … 90 00', 'A 128-byte signature'],
];

function ApduLog() {
  const ref = useRef(null);
  const p = useScrollProgress(ref);
  const shown = Math.round(p * APDU.length);
  return (
    <ol className="apdu" ref={ref}>
      {APDU.map(([dir, hex, what], i) => (
        <li key={i} className={`${dir === 'rx' ? 'rx' : ''}${i < shown ? ' on' : ''}`}>
          <span className="dir" aria-hidden="true">{dir === 'rx' ? '←' : '→'}</span><span className="sr-only">{dir === 'rx' ? 'Card replies: ' : 'Reader sends: '}</span><code>{hex}</code><em>{what}</em>
        </li>
      ))}
    </ol>
  );
}

function HowATapWorks() {
  return (
    <section className="night" id="how">
      <div className="wrap chapter-head">
        <span className="eyebrow">01 · How a tap works</span>
        <h2>A contactless payment is a short radio conversation.</h2>
        <p>No battery, no pairing, no Bluetooth. Just two coils of copper and a magnetic field.</p>
      </div>

      <Step station="tap1" no="Step 1 of 3 · The field" title="The reader fills the air with a magnetic field.">
        <p>The terminal runs alternating current through a coil of copper, <strong>13.56 million times a second</strong>. That makes a magnetic field that reaches a few centimetres above the reader. This is NFC, the short-range kind of RFID that bank cards use.</p>
        <div className="chips"><span className="chip">13.56 MHz</span><span className="chip">106 kbit/s</span><span className="chip">a few cm</span><span className="chip">ISO/IEC 14443</span></div>
      </Step>

      <Step station="tap2" no="Step 2 of 3 · The antenna" title="Your card has an antenna, and no battery.">
        <p>A coil of fine copper wire is laminated inside the plastic, running around the edge of the card. When it enters the reader's field, the field <strong>induces a current</strong> in the coil. That current powers the chip, so the card only wakes up while it's held near a reader.</p>
        <p className="note">Peel the face off any contactless card and you'll find this coil, joined to the chip module.</p>
      </Step>

      <Step station="tap3" no="Step 3 of 3 · The conversation" title="The chip answers by changing its load.">
        <p>To reply, the chip switches a small load on and off. The card draws a little more or less energy from the field, and the reader decodes those changes as bits. The messages are <strong>APDUs</strong>, the same commands a chip-and-PIN terminal sends. This is what our reader sends:</p>
        <ApduLog />
      </Step>
    </section>
  );
}

/* ---------------------------------------------------------------- chapter 2: the secret */

const CHAIN = [
  ['Mastercard root key', 'public, in every terminal'],
  ["Your bank's key", 'certificate · tag 90'],
  ["Your card's key", 'certificate · tag 9F46'],
  ['Our 4-byte challenge', 'signature · tag 9F4B'],
];

function TheSecret() {
  return (
    <section className="night" id="secret">
      <div className="wrap chapter-head">
        <span className="eyebrow">02 · The secret inside</span>
        <h2>Behind the gold contacts is a key that never comes out.</h2>
        <p>This is the part most people don't know about their own card.</p>
      </div>

      <Step station="secret1" no="Step 1 of 3 · The vault" title="The chip keeps a private key it will never reveal.">
        <p>When a bank issues a chip card, it loads an <strong>RSA private key</strong> into the chip's secure element. There is no command that reads the key back out, and the chip is built to resist being opened or probed. The chip can only use the key. Hand it some data and it returns a signature.</p>
        <div className="split">
          <div><b>Any reader can get</b><span>The card's public key, in certificates signed by the bank</span></div>
          <div><b>Nobody can get</b><span>The private key. Not the terminal, not the phone, not us.</span></div>
        </div>
      </Step>

      <Step station="secret2" no="Step 2 of 3 · The signature" title="Send it four random bytes and it signs them.">
        <p>This is EMV <strong>dynamic data authentication</strong>. The terminal sends a fresh 4-byte challenge in an INTERNAL AUTHENTICATE command. The card signs it with its private key and returns a 128-byte RSA signature. No PIN, no bank and no card network are involved.</p>
        <div className="sigflow">
          <div className="box"><small>Challenge</small>7F 3A 9C 21</div>
          <span className="arrow">→ card →</span>
          <div className="sig"><small>Signature · 128 bytes</small>3B 9E 51 C4 0D 77 A2 E9 16 5F C8 03 B4 …</div>
        </div>
      </Step>

      <Step station="secret3" no="Step 3 of 3 · The proof" title="Anyone can check that a real bank card signed.">
        <p>The card hands over its public key in a certificate signed by its bank. The bank's key is certified by Mastercard or Visa, whose root keys are public and built into every terminal. Follow the chain and you know the signature came from a genuine, bank-issued card.</p>
        <ol className="chain">
          {CHAIN.map(([k, v]) => <li key={k}><b>{k}</b><span>{v}</span></li>)}
        </ol>
        <p className="note">On day 1 we did this with a real Indian-issued Mastercard: 1024-bit RSA, exponent 3, verified end to end.</p>
      </Step>
    </section>
  );
}

/* ---------------------------------------------------------------- chapter 3: payments */

const H = '7f3a9c21d84e06b5c13f9a77e2580cd4b96f21a0e83d5c47f0129be6a35dc818'.match(/../g);

function HashBytes() {
  const ref = useRef(null);
  const p = useScrollProgress(ref);
  const lit = Math.round(p * 36);
  return (
    <div className="bytes" ref={ref}>
      {H.map((b, i) => <span key={i} className={`${i < 4 ? 'card' : ''}${i < lit ? ' on' : ''}`}>{b.toUpperCase()}</span>)}
    </div>
  );
}

const CHECKS = [
  ['Rebuilds H from the payment details', ''],
  ["Card's RSA signature, via the modexp precompile + SHA-1", '151,139 gas'],
  ["Phone's P-256 passkey signature, via the P-256 precompile", '62,716 gas'],
  ['Nonce, expiry, spending limits and the freeze switch', ''],
];

function ContractChecks() {
  const ref = useRef(null);
  const p = useScrollProgress(ref);
  const lit = Math.round(p * (CHECKS.length + 1));
  return (
    <ul className="checks" ref={ref}>
      {CHECKS.map(([what, gas], i) => (
        <li key={what} className={i < lit ? 'on' : ''}><Tick /><span>{what}</span><span className="gas">{gas}</span></li>
      ))}
      <li className={`total${lit > CHECKS.length ? ' on' : ''}`}><Tick color="#FFE600" /><span>Pays the merchant in stablecoins</span><span className="gas">320,193 gas</span></li>
    </ul>
  );
}

function Payments() {
  return (
    <section className="sheet" id="pay">
      <div className="wrap chapter-head on-paper">
        <span className="eyebrow">03 · How a payment works</span>
        <h2>Tap2ETH puts that key in charge of a wallet.</h2>
        <p>The card's public key is stored in a smart contract wallet, next to a passkey from your phone. By default, money only moves when both of them sign. You can opt in to single-signature payments below a small limit.</p>
      </div>

      <Step station="pay1" no="Step 1 of 2 · Two signatures" title="Every payment needs your card and your phone.">
        <p>The terminal hashes the payment into a 32-byte value, <strong>H</strong>. The card signs the first 4 bytes of H, which proves the physical card was tapped. Your phone shows the payment, and after your fingerprint its passkey signs <strong>all 32 bytes</strong>, which proves you approved exactly this payment.</p>
        <div className="formula">H = keccak256(<i>wallet, merchant, token, amount, nonce, expiry, chainId</i>)</div>
        <HashBytes />
        <div className="legend"><span><i className="y" />Card signs these 4</span><span><i />Phone signs all 32</span></div>
      </Step>

      <Step station="pay2" no="Step 2 of 2 · The contract" title="The wallet contract checks every signature itself.">
        <ContractChecks />
        <p>A relayer pays the gas, so you never need the network's coin. It can't move your money, because the contract checks every signature.</p>
      </Step>
    </section>
  );
}

/* ---------------------------------------------------------------- proof, features, compare, limits */

const RECEIPTS = [
  { meta: ['Day 1', 'Reader'], title: 'A real card signed our challenge', body: "An Indian-issued Mastercard opened app A0000000041010 and signed our 4-byte challenge. The signature verified from the Mastercard root key to the card's own key.", stamp: 'RSA-1024 · e = 3' },
  { meta: ['Whitechain Sepolia', 'Phone'], title: '0.3 USDT sent with card + fingerprint', body: 'A real bank card and a Galaxy A52s sent 0.3 USDT from a Tap2ETH smart wallet.', tx: [`${WC}/tx/0x31945fb2ff21ecd3f123011690a0481a6f8fcf0f0a46db9fb27fd2a84e7d2eea`, 'tx 0x31945fb2…2eea ↗'] },
  { meta: ['6 Nov 2026', 'Terminal'], title: '12 tUSDC paid at our terminal', body: 'A wallet made by scanning a Mastercard with a Galaxy S22 Ultra, then a card tap at our M5Stick terminal, approved by fingerprint and settled on-chain.', stamp: 'Paid ✓' },
  { meta: ['Arc testnet', 'USDC gas'], title: '0.01 USDC settled on Arc', body: 'The same card + phone payment on Arc testnet, where gas is paid in USDC.', tx: [`${ARC}/tx/0x7cbb741be0aa18738188bc204898fba6707c22557bcabd51e148e4d478002c8b`, 'tx 0x7cbb741b…2c8b ↗'] },
];
const GAS = [
  ['Check a card signature (RSA + SHA-1)', '151,139'],
  ['Check a phone signature (P-256)', '62,716'],
  ['Pay with card + phone', '320,193'],
  ['Pay with the card alone (tiny amount)', '199,028'],
  ['Create a wallet (clone + 2 proofs)', '765,960'],
  ['Freeze with the phone', '104,422'],
];
const CONTRACTS = [
  ['Tap2EthFactoryV2', 'Whitechain Sepolia', `${WC}/address/0xb413D6AA35c3901Bac6D441e8f1b38640416557A#code`, '0xb413D6AA35c3901Bac6D441e8f1b38640416557A'],
  ['Tap2EthWalletV2', 'Whitechain Sepolia · implementation', `${WC}/address/0x75572741C89B0665fB3A30473B831f0e83153b88#code`, '0x75572741C89B0665fB3A30473B831f0e83153b88'],
  ['Tap2Eth', 'Arc testnet', `${ARC}/address/0xd7783c67607704a19018015E184fFd008392A363?tab=contract`, '0xd7783c67607704a19018015E184fFd008392A363'],
];

function Proof() {
  return (
    <section className="section proof" id="proof" data-station="gone1" data-anchor="top">
      <div className="wrap">
        <div className="section-head reveal">
          <span className="eyebrow">04 · Proof</span>
          <h2>Tested with real bank cards, on live testnets.</h2>
          <p>The receipts below used our own bank cards and phones, and the terminal we built from a Raspberry Pi and an M5StickS3 with an RFID reader. The automated checks and gas figures use generated test cards and a test token.</p>
        </div>
        <div className="receipts">
          {RECEIPTS.map(r => (
            <article className="receipt reveal" key={r.title}>
              <div className="rmeta"><span>{r.meta[0]}</span><span>{r.meta[1]}</span></div>
              <h3>{r.title}</h3>
              <p>{r.body}</p>
              {r.stamp && <span className="stamp">{r.stamp}</span>}
              {r.tx && <Ext className="tx" href={r.tx[0]}>{r.tx[1]}</Ext>}
            </article>
          ))}
        </div>
        <div className="numbers reveal">
          <div><b>36 / 36</b><span>live contract checks on Whitechain Sepolia, with test cards</span></div>
          <div><b>37 / 37</b><span>relayer end-to-end checks on Whitechain Sepolia, with test cards</span></div>
          <div><b>54 / 54</b><span>checks including lost-phone recovery, on a local chain, with test cards</span></div>
        </div>
        <div className="tables">
          <div className="table-box reveal">
            <h3 id="gas-title">Gas, measured on Whitechain Sepolia</h3>
            <table className="gas-table" aria-labelledby="gas-title">
              <thead className="sr-only"><tr><th scope="col">Operation</th><th scope="col">Gas</th></tr></thead>
              <tbody>{GAS.map(([k, v]) => <tr key={k}><th scope="row">{k}</th><td>{v}</td></tr>)}</tbody>
            </table>
            <p className="src">Chain ID 1874. The two signature checks come from the v1 smoke test; the other rows from the v2 smoke test.</p>
          </div>
          <div className="table-box reveal">
            <h3>Deployed, source verified</h3>
            <ul className="addr">
              {CONTRACTS.map(([name, net, href, addr]) => (
                <li key={addr}><b>{name}</b><span>{net}</span><Ext href={href}>{addr}</Ext></li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

const FEATURES = [
  { cls: 'big', title: 'Spending limits on-chain', body: "Every wallet has a per-payment limit and a daily limit, enforced by the contract. Raising them needs the full set of signatures, so a stolen phone or a skimmed card can't lift them.", needs: 'Change limits · card + phone' },
  { cls: 'y', title: 'Freeze in one tap', body: "Lost your wallet? Freeze with your phone alone. Freezing can't move money, so one factor is enough.", needs: 'Unfreeze · card + phone' },
  { title: 'More cards, more keys', body: 'Add more cards or phones, up to 8 signers, and require 2 of 3 or 3 of 3 for a payment.', needs: 'Add a signer · threshold + the new key' },
  { title: 'Tiny payments, card only', body: 'Optional. Below a small limit you choose, a card tap alone can pay, like contactless today.', needs: 'Off by default' },
  { title: 'Lost your phone?', body: 'Two of your cards start a recovery to a new phone. It waits out a delay, and any signer can cancel it.', needs: 'Two cards + new phone · time lock · demo-strength' },
];

function Features() {
  return (
    <section className="section features" id="features">
      <div className="wrap">
        <div className="section-head reveal">
          <span className="eyebrow">05 · The wallet</span>
          <h2>A real wallet, with the safety rails a bank card has.</h2>
        </div>
        <div className="bento">
          {FEATURES.map(f => (
            <article key={f.title} className={`tile reveal ${f.cls || ''}`}>
              <h3>{f.title}</h3><p>{f.body}</p><span className="needs">{f.needs}</span>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

const COMPARE = [
  ['Crypto debit cards', 'Gnosis Pay, MetaMask Card', 'Issue you a new card through a card issuer, with new KYC.'],
  ['NFC crypto cards', 'HaLo, Burner', 'New hardware to buy and carry.'],
  ['Zero-knowledge', 'zkEMV', "Proves you hold a card, privately. It isn't a payment wallet."],
];

function Compare() {
  return (
    <section className="section compare">
      <div className="wrap">
        <div className="section-head reveal">
          <span className="eyebrow">06 · Why it's different</span>
          <h2>No new card. No new device. No new KYC.</h2>
        </div>
        <div className="cmp reveal">
          {COMPARE.map(([k, h, p]) => <div key={k}><b>{k}</b><h3>{h}</h3><p>{p}</p></div>)}
          <div className="us"><b>Tap2ETH</b><h3>The card you already carry</h3><p>A full payment wallet with limits, a merchant terminal, two-factor approval and recovery.</p></div>
        </div>
      </div>
    </section>
  );
}

const LIMITS = [
  ['The card has no screen.', "It signs for any reader within a few centimetres. That's why every payment also needs your phone."],
  ["The bank made the card's key.", "So the card alone isn't full self-custody. With the phone required, no single party (bank, thief or us) can move funds."],
  ['A card signs only 4 bytes.', 'The phone signs the full 32-byte payment hash, which binds the exact payment.'],
  ['A reissued card has a new key.', 'The wallet supports swapping in the new card, behind a time lock.'],
  ['Android only for now.', "iPhones don't let apps send payment commands to bank cards."],
  ['Phone recovery is demo-strength.', 'Each card signs only 4 bytes of the request. A stronger 12-byte version (v3) is written but not deployed, and recovery in the app is not yet tested on a phone.'],
  ['Tested with Mastercard.', 'Signing uses EMV DDA. Cards with only static authentication have no card key, and Visa cards are not yet verified.'],
  ['Testnets only.', 'The 1024-bit card keys are legacy-grade, one more reason the phone factor is mandatory.'],
];

function Limits() {
  return (
    <section className="section limits" id="limits" data-station="gone2" data-anchor="top">
      <div className="wrap">
        <div className="section-head reveal">
          <span className="eyebrow">07 · Known limits</span>
          <h2>What a bank card can't do on its own.</h2>
        </div>
        <ul className="limit-list">
          {LIMITS.map(([b, s]) => <li key={b}><b>{b}</b><span>{s}</span></li>)}
        </ul>
      </div>
    </section>
  );
}

function Outro() {
  return (
    <section className="outro" id="start" data-station="outro">
      <div className="wrap">
        <div className="outro-copy">
          <span className="eyebrow">Tap2ETH</span>
          <h2>Your card has been a signing key all along.</h2>
          <p>Android app, merchant terminal, relayer and contracts. All open source, built in Mumbai.</p>
          <div className="cta-row">
            <Ext className="btn btn-ink" href={GITHUB}>Code on GitHub</Ext>
            <Ext className="btn" href={`${GITHUB}/blob/main/docs/SPEC.md`}>Read the spec</Ext>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer>
      <div className="wrap">
        <a className="brand" href="#top">Tap2ETH</a>
        <nav aria-label="Footer">
          <Ext href={GITHUB}>GitHub</Ext>
          <Ext href={`${WC}/address/0xb413D6AA35c3901Bac6D441e8f1b38640416557A`}>Whitechain factory</Ext>
          <Ext href={`${ARC}/address/0xd7783c67607704a19018015E184fFd008392A363`}>Arc contract</Ext>
        </nav>
        <small>Built at ETHGlobal Mumbai 2026 by team-somehow. Testnet software, not a bank product. Visa and Mastercard are trademarks of their owners; Tap2ETH isn't affiliated with them.</small>
      </div>
    </footer>
  );
}

export default function App() {
  const heroStageRef = useRef(null);
  return (
    <>
      <Nav />
      <Stage heroStageRef={heroStageRef} />
      <main>
        <Hero stageRef={heroStageRef} />
        <Statement />
        <Ticker />
        <HowATapWorks />
        <TheSecret />
        <Payments />
        <Proof />
        <Features />
        <Compare />
        <Limits />
        <Outro />
      </main>
      <Footer />
    </>
  );
}
