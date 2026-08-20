import KbChatLaunchClient from './KbChatLaunchClient';
import BotAccessGate from '../../components/BotAccessGate';

export const dynamic = 'force-dynamic';

export default function KbChatPage() {
    return <BotAccessGate botKey="kb-chat"><KbChatLaunchClient /></BotAccessGate>;
}
