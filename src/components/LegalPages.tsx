import type { ReactNode } from 'react';
import { BrandLogo } from './BrandLogo';

const CONTACT_EMAIL = 'owner@nurseryos.app';
const SITE = 'https://nurseryos.app';
const EFFECTIVE = 'August 16, 2026';

type LegalKind = 'privacy' | 'terms';

function readLegalPath(pathname = window.location.pathname): LegalKind | null {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/privacy') return 'privacy';
  if (p === '/terms') return 'terms';
  return null;
}

function LegalShell({
  title,
  children
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <a href="/" className="inline-flex items-center gap-2 no-underline">
            <BrandLogo variant="icon" size="sm" showText nurseryName="NurseryOS" />
          </a>
          <nav className="flex gap-4 text-sm font-medium text-slate-600">
            <a href="/privacy" className="hover:text-emerald-700">
              Privacy
            </a>
            <a href="/terms" className="hover:text-emerald-700">
              Terms
            </a>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
          {title}
        </h1>
        <p className="mt-2 text-sm text-slate-500">Effective date: {EFFECTIVE}</p>
        <div className="prose-legal mt-8 space-y-6 text-[15px] leading-relaxed text-slate-700">
          {children}
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 py-6 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span>© {new Date().getFullYear()} NurseryOS</span>
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-emerald-700 hover:underline">
            {CONTACT_EMAIL}
          </a>
        </div>
      </footer>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold text-slate-900">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function PrivacyContent() {
  return (
    <LegalShell title="Privacy Policy">
      <Section title="Who we are">
        <p>
          NurseryOS (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) provides nursery operations software at{' '}
          <a href={SITE} className="text-emerald-700 hover:underline">
            {SITE}
          </a>
          . This Privacy Policy explains how we collect, use, and share information when you use our
          website and applications, including when you connect third-party services such as Intuit
          QuickBooks.
        </p>
      </Section>

      <Section title="Information we collect">
        <p>We may collect:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Account information</strong> — name, email address, nursery/business name, and
            authentication data when you create or join a workspace.
          </li>
          <li>
            <strong>Business data you enter</strong> — orders, inventory, customers, invoices, team
            members, and related operational records you store in NurseryOS.
          </li>
          <li>
            <strong>QuickBooks connection data</strong> — when you authorize QuickBooks Online, we
            receive OAuth tokens and company identifiers needed to sync customers, invoices, and
            related accounting data you choose to connect. We do not store your Intuit password.
          </li>
          <li>
            <strong>Usage and device data</strong> — basic logs (IP address, browser type, timestamps)
            used for security, reliability, and troubleshooting.
          </li>
        </ul>
      </Section>

      <Section title="How we use information">
        <p>We use information to:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Provide, operate, and improve NurseryOS</li>
          <li>Authenticate users and manage workspace access</li>
          <li>Sync data with QuickBooks Online when you connect that integration</li>
          <li>Send transactional messages (invites, password resets, invoices, support)</li>
          <li>Detect abuse, prevent fraud, and keep the service secure</li>
        </ul>
        <p>We do not sell your personal information.</p>
      </Section>

      <Section title="Sharing">
        <p>We may share information with:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Service providers</strong> who host or process data on our behalf (for example
            cloud hosting, authentication, email delivery), under contractual obligations to protect
            it.
          </li>
          <li>
            <strong>Intuit QuickBooks</strong> when you authorize the connection, so we can create or
            update customers, invoices, and related records you request.
          </li>
          <li>
            <strong>Legal requirements</strong> if required by law, regulation, or valid legal process.
          </li>
        </ul>
      </Section>

      <Section title="Data retention">
        <p>
          We retain account and business data for as long as your workspace is active or as needed to
          provide the service. You may request deletion of your account or workspace data by
          contacting us. Backups and logs may persist for a limited period after deletion.
        </p>
      </Section>

      <Section title="Security">
        <p>
          We use industry-standard measures to protect data in transit and at rest. No method of
          transmission or storage is 100% secure; please use a strong password and protect your login
          credentials.
        </p>
      </Section>

      <Section title="Your choices">
        <p>
          You can disconnect QuickBooks from NurseryOS settings at any time. You may request access,
          correction, or deletion of your personal information by emailing{' '}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-emerald-700 hover:underline">
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </Section>

      <Section title="Children">
        <p>
          NurseryOS is intended for business use by adults. We do not knowingly collect personal
          information from children under 13.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          We may update this Privacy Policy from time to time. The effective date above will be
          revised when we do. Continued use of NurseryOS after changes means you accept the updated
          policy.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions about privacy:{' '}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-emerald-700 hover:underline">
            {CONTACT_EMAIL}
          </a>
        </p>
      </Section>
    </LegalShell>
  );
}

function TermsContent() {
  return (
    <LegalShell title="Terms of Service">
      <Section title="Agreement">
        <p>
          These Terms of Service (&quot;Terms&quot;) govern your access to and use of NurseryOS at{' '}
          <a href={SITE} className="text-emerald-700 hover:underline">
            {SITE}
          </a>{' '}
          and related applications (the &quot;Service&quot;). By creating an account or using the
          Service, you agree to these Terms.
        </p>
      </Section>

      <Section title="The Service">
        <p>
          NurseryOS provides tools for nursery and plant wholesale operations, including orders,
          inventory, truck loading, invoicing, team collaboration, and optional integrations such as
          QuickBooks Online. Features may change as we improve the product.
        </p>
      </Section>

      <Section title="Accounts">
        <p>
          You are responsible for maintaining the confidentiality of your login credentials and for
          activity under your account. Workspace owners are responsible for inviting and managing
          team members and for the accuracy of business data entered into the Service.
        </p>
      </Section>

      <Section title="Acceptable use">
        <p>You agree not to:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Use the Service for unlawful purposes</li>
          <li>Attempt to gain unauthorized access to systems or other customers&apos; data</li>
          <li>Interfere with or disrupt the Service</li>
          <li>Upload malicious code or abuse AI / upload features</li>
          <li>Misrepresent your identity or affiliation when connecting third-party services</li>
        </ul>
      </Section>

      <Section title="Your data">
        <p>
          You retain ownership of the business content you submit to NurseryOS. You grant us a limited
          license to host, process, and display that content solely to operate and improve the
          Service. Our handling of personal information is described in our{' '}
          <a href="/privacy" className="text-emerald-700 hover:underline">
            Privacy Policy
          </a>
          .
        </p>
      </Section>

      <Section title="Third-party services">
        <p>
          If you connect QuickBooks Online or other third-party services, you authorize us to access
          and exchange data as needed for the features you use. Those services are governed by their
          own terms and privacy policies. We are not responsible for third-party outages or changes to
          their APIs.
        </p>
      </Section>

      <Section title="Billing">
        <p>
          Paid plans, if offered, will be described at the time of purchase. Fees are non-refundable
          except where required by law or expressly stated otherwise. We may change pricing with
          reasonable notice for renewals.
        </p>
      </Section>

      <Section title="Disclaimer">
        <p>
          THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; WITHOUT WARRANTIES OF
          ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
          AND NON-INFRINGEMENT. We do not warrant that the Service will be uninterrupted or
          error-free.
        </p>
      </Section>

      <Section title="Limitation of liability">
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, NURSERYOS AND ITS OPERATORS SHALL NOT BE LIABLE FOR
          INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS,
          DATA, OR BUSINESS, ARISING FROM YOUR USE OF THE SERVICE. OUR TOTAL LIABILITY FOR ANY CLAIM
          RELATED TO THE SERVICE SHALL NOT EXCEED THE AMOUNTS YOU PAID US IN THE TWELVE (12) MONTHS
          BEFORE THE CLAIM (OR ONE HUNDRED U.S. DOLLARS IF YOU HAVE NOT PAID).
        </p>
      </Section>

      <Section title="Termination">
        <p>
          You may stop using the Service at any time. We may suspend or terminate access if you
          violate these Terms or if needed to protect the Service or other users. Upon termination,
          your right to use the Service ends; provisions that by nature should survive will survive.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          We may update these Terms from time to time. Continued use after the effective date of
          changes constitutes acceptance. If you do not agree, stop using the Service.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions about these Terms:{' '}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-emerald-700 hover:underline">
            {CONTACT_EMAIL}
          </a>
        </p>
      </Section>
    </LegalShell>
  );
}

export function readLegalPageFromPath(pathname = window.location.pathname): LegalKind | null {
  return readLegalPath(pathname);
}

export function LegalPage({ kind }: { kind: LegalKind }) {
  return kind === 'privacy' ? <PrivacyContent /> : <TermsContent />;
}
