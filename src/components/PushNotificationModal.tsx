import { Bell, X } from 'lucide-react';
import { useT } from '../lib/i18n';
import { PushNotificationPanel } from './PushNotificationPanel';

interface PushNotificationModalProps {
  tenantId: string;
  onClose: () => void;
}

export function PushNotificationModal({ tenantId, onClose }: PushNotificationModalProps) {
  const t = useT();

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-ink-700" />
            <h3 className="font-bold text-gray-900">{t('header.notifications')}</h3>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5">
          <PushNotificationPanel tenantId={tenantId} compact />
        </div>
      </div>
    </div>
  );
}
