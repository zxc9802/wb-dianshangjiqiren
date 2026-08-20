import VideoWorkbenchClient from '../video-workbench/VideoWorkbenchClient';
import BotAccessGate from '../../components/BotAccessGate';

export const dynamic = 'force-dynamic';

export default function LegacyVideoWorkbenchSeedancePage() {
    return <BotAccessGate botKey="video-workbench"><VideoWorkbenchClient site="seedance" /></BotAccessGate>;
}
