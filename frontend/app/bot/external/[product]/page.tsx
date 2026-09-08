import BotAccessGate from '@/app/components/BotAccessGate';
import { parseExternalSsoProduct } from '@/app/lib/external-sso';
import LaunchClient from './LaunchClient';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ product: string }> }) {
    const product = parseExternalSsoProduct((await params).product);
    return <BotAccessGate botKey={product}><LaunchClient product={product} /></BotAccessGate>;
}
