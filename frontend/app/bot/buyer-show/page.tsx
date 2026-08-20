import BuyerShowLaunchClient from './BuyerShowLaunchClient';
import BotAccessGate from '../../components/BotAccessGate';

export const dynamic = 'force-dynamic';

export default function BuyerShowPage() {
    return <BotAccessGate botKey="buyer-show"><BuyerShowLaunchClient /></BotAccessGate>;
}
