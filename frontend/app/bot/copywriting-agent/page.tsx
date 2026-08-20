import CopywritingAgentLaunchClient from './CopywritingAgentLaunchClient';
import BotAccessGate from '../../components/BotAccessGate';

export const dynamic = 'force-dynamic';

export default function CopywritingAgentPage() {
    return <BotAccessGate botKey="copywriting-agent"><CopywritingAgentLaunchClient /></BotAccessGate>;
}
