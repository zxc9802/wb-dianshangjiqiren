import { redirect } from 'next/navigation';
import { parseExternalSsoProduct } from '@/app/lib/external-sso';
export default async function Page({ searchParams }: { searchParams: Promise<{ externalSso?: string }> }) {
    const { externalSso } = await searchParams;
    if (!externalSso) redirect('/');
    const product = parseExternalSsoProduct(externalSso);
    redirect('/bot/external/' + product);
}
