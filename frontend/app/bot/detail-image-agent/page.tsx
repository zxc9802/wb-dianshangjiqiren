import DetailImageAgentLaunchClient from './DetailImageAgentLaunchClient';
import BotAccessGate from '../../components/BotAccessGate';

export const dynamic = 'force-dynamic';

export default function DetailImageAgentPage() {
    return <BotAccessGate botKey="detail-image-agent"><DetailImageAgentLaunchClient /></BotAccessGate>;
}
