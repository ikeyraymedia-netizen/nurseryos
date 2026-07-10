import { ReactNode, useEffect, useRef, useState } from 'react';
import { ContainerWeight, InventoryPlant } from '../types';
import { AppPermissions } from '../lib/permissions';
import {
  InventoryMatchRequest,
  setInventoryMatchResolver
} from '../lib/inventory';
import { InventoryMatchModal } from './InventoryMatchModal';

interface InventoryMatchProviderProps {
  children: ReactNode;
  containerWeights: ContainerWeight[];
  permissions: AppPermissions;
}

export function InventoryMatchProvider({
  children,
  containerWeights,
  permissions
}: InventoryMatchProviderProps) {
  const [pending, setPending] = useState<{
    request: InventoryMatchRequest;
    resolve: (result: InventoryPlant[] | null) => void;
  } | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    setInventoryMatchResolver(async (request) => {
      return new Promise<InventoryPlant[] | null>((resolve) => {
        setPending({ request, resolve });
      });
    });
    return () => setInventoryMatchResolver(null);
  }, []);

  function handleResolve(plants: InventoryPlant[] | null) {
    pendingRef.current?.resolve(plants);
    setPending(null);
  }

  return (
    <>
      {children}
      {pending && (
        <InventoryMatchModal
          request={pending.request}
          containerWeights={containerWeights}
          permissions={permissions}
          onResolve={handleResolve}
        />
      )}
    </>
  );
}
