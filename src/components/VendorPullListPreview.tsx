import { VendorPullList } from '../lib/pullSheet';
import { useT } from '../lib/i18n';

export function vendorCallCounts(list: VendorPullList): { called: number; open: number } {
  let called = 0;
  let open = 0;
  for (const section of list.sections) {
    for (const line of section.lines) {
      if (line.calledIn) called += 1;
      else open += 1;
    }
  }
  return { called, open };
}

/** On-screen vendor list. Called lines use the same amber as the Called in button. */
export function VendorPullListPreview({ list }: { list: VendorPullList }) {
  const t = useT();
  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      {list.sections.map((section, sectionIndex) => (
        <div key={`${section.heading}-${sectionIndex}`} className={sectionIndex > 0 ? 'border-t border-gray-100' : ''}>
          <div className="px-2.5 py-1.5 bg-slate-50">
            <p className="text-[11px] font-black text-gray-900">{section.heading}</p>
            <p className="text-[10px] text-gray-500">{section.meta}</p>
          </div>
          <ul>
            {section.lines.map((line, lineIndex) => (
              <li
                key={`${line.label}-${lineIndex}`}
                className={`px-2.5 py-1.5 text-[11px] leading-snug flex items-start justify-between gap-2 ${
                  line.calledIn ? 'bg-amber-50 text-amber-950' : 'bg-white text-gray-900'
                }`}
              >
                <span className="font-mono min-w-0">{line.label}</span>
                <span
                  className={`shrink-0 mt-0.5 text-[9px] font-black uppercase tracking-wide rounded px-1.5 py-0.5 ${
                    line.calledIn
                      ? 'bg-amber-600 text-white'
                      : 'bg-white border border-amber-300 text-amber-800'
                  }`}
                >
                  {line.calledIn ? t('trucksExtra.vendorLineCalled') : t('trucksExtra.vendorLineNotCalled')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
