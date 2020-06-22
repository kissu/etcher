/*
 * Copyright 2016 balena.io
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
	faFile,
	faLink,
	faExclamationTriangle,
	faCopy,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { sourceDestination, scanner } from 'etcher-sdk';
import { ipcRenderer, IpcRendererEvent } from 'electron';
import * as _ from 'lodash';
import { GPTPartition, MBRPartition } from 'partitioninfo';
import * as path from 'path';
import * as React from 'react';
import {
	ButtonProps,
	Card as BaseCard,
	Input,
	Modal as SmallModal,
	Txt,
	Flex,
} from 'rendition';
import styled from 'styled-components';

import * as errors from '../../../../shared/errors';
import * as messages from '../../../../shared/messages';
import * as supportedFormats from '../../../../shared/supported-formats';
import * as shared from '../../../../shared/units';
import * as selectionState from '../../models/selection-state';
import { observe } from '../../models/store';
import * as analytics from '../../modules/analytics';
import * as exceptionReporter from '../../modules/exception-reporter';
import * as osDialog from '../../os/dialog';
import { replaceWindowsNetworkDriveLetter } from '../../os/windows-network-drives';
import {
	ChangeButton,
	DetailsText,
	Modal,
	StepButton,
	StepNameButton,
} from '../../styled-components';
import { colors } from '../../theme';
import { middleEllipsis } from '../../utils/middle-ellipsis';
import { SVGIcon } from '../svg-icon/svg-icon';

import ImageSvg from '../../../assets/image.svg';
import { DriveSelector } from '../drive-selector/drive-selector';

const recentUrlImagesKey = 'recentUrlImages';

function normalizeRecentUrlImages(urls: any): string[] {
	if (!Array.isArray(urls)) {
		urls = [];
	}
	return _.chain(urls)
		.filter(_.isString)
		.reject(_.isEmpty)
		.uniq()
		.takeRight(5)
		.value();
}

function getRecentUrlImages(): string[] {
	let urls = [];
	try {
		urls = JSON.parse(localStorage.getItem(recentUrlImagesKey) || '[]');
	} catch {
		// noop
	}
	return normalizeRecentUrlImages(urls);
}

function setRecentUrlImages(urls: string[]) {
	localStorage.setItem(
		recentUrlImagesKey,
		JSON.stringify(normalizeRecentUrlImages(urls)),
	);
}

const isURL = (imagePath: string) =>
	imagePath.startsWith('https://') || imagePath.startsWith('http://');

const Card = styled(BaseCard)`
	hr {
		margin: 5px 0;
	}
`;

// TODO move these styles to rendition
const ModalText = styled.p`
	a {
		color: rgb(0, 174, 239);

		&:hover {
			color: rgb(0, 139, 191);
		}
	}
`;

function getState() {
	return {
		hasImage: selectionState.hasImage(),
		imageName: selectionState.getImageName(),
		imageSize: selectionState.getImageSize(),
	};
}

const URLSelector = ({
	done,
	cancel,
}: {
	done: (imageURL: string) => void;
	cancel: () => void;
}) => {
	const [imageURL, setImageURL] = React.useState('');
	const [recentImages, setRecentImages]: [
		string[],
		(value: React.SetStateAction<string[]>) => void,
	] = React.useState([]);
	const [loading, setLoading] = React.useState(false);
	React.useEffect(() => {
		const fetchRecentUrlImages = async () => {
			const recentUrlImages: string[] = await getRecentUrlImages();
			setRecentImages(recentUrlImages);
		};
		fetchRecentUrlImages();
	}, []);
	return (
		<Modal
			cancel={cancel}
			primaryButtonProps={{
				disabled: loading || !imageURL,
			}}
			done={async () => {
				setLoading(true);
				const sanitizedRecentUrls = normalizeRecentUrlImages([
					...recentImages,
					imageURL,
				]);
				setRecentUrlImages(sanitizedRecentUrls);
				await done(imageURL);
			}}
		>
			<Flex style={{ width: '100%' }} flexDirection="column">
				<Txt mb="10px" fontSize="24px">
					Use Image URL
				</Txt>
				<Input
					value={imageURL}
					placeholder="Enter a valid URL"
					type="text"
					onChange={(evt: React.ChangeEvent<HTMLInputElement>) =>
						setImageURL(evt.target.value)
					}
				/>
			</Flex>
			{!_.isEmpty(recentImages) && (
				<Flex flexDirection="column">
					<Txt fontSize={18}>Recent</Txt>
					<Card
						style={{ padding: '10px 15px' }}
						rows={_.map(recentImages, (recent) => (
							<Txt
								key={recent}
								onClick={() => {
									setImageURL(recent);
								}}
							>
								<span>
									{_.last(_.split(recent, '/'))} - {recent}
								</span>
							</Txt>
						))}
					/>
				</Flex>
			)}
		</Modal>
	);
};

interface Flow {
	icon?: JSX.Element;
	onClick: (evt: React.MouseEvent) => void;
	label: string;
}

const FlowSelector = styled(
	({ flow, ...props }: { flow: Flow; props?: ButtonProps }) => {
		return (
			<StepButton
				plain
				onClick={(evt) => flow.onClick(evt)}
				icon={flow.icon}
				{...props}
			>
				{flow.label}
			</StepButton>
		);
	},
)`
	border-radius: 24px;
	color: rgba(255, 255, 255, 0.7);

	:enabled:hover {
		background-color: ${colors.primary.background};
		color: ${colors.primary.foreground};
		font-weight: 600;

		svg {
			color: ${colors.primary.foreground}!important;
		}
	}
`;

export type Source =
	| typeof sourceDestination.File
	| typeof sourceDestination.BlockDevice
	| typeof sourceDestination.Http;

export interface SourceMetadata extends sourceDestination.Metadata {
	hasMBR: boolean;
	partitions: MBRPartition[] | GPTPartition[];
	path: string;
	SourceType: Source;
	drive?: scanner.adapters.DrivelistDrive;
	extension?: string;
}
export interface SourceOptions {
	sourcePath: string;
	SourceType: Source;
}

interface SourceSelectorProps {
	flashing: boolean;
	afterSelected: (options: SourceOptions) => void;
}

interface SourceSelectorState {
	hasImage: boolean;
	imageName: string;
	imageSize: number;
	warning: { message: string; title: string | null } | null;
	showImageDetails: boolean;
	showURLSelector: boolean;
	showDriveSelector: boolean;
}

export class SourceSelector extends React.Component<
	SourceSelectorProps,
	SourceSelectorState
> {
	private unsubscribe: () => void;

	constructor(props: SourceSelectorProps) {
		super(props);
		this.state = {
			...getState(),
			warning: null,
			showImageDetails: false,
			showURLSelector: false,
			showDriveSelector: false,
		};
	}

	public componentDidMount() {
		this.unsubscribe = observe(() => {
			this.setState(getState());
		});
		ipcRenderer.on('select-image', this.onSelectImage);
		ipcRenderer.send('source-selector-ready');
	}

	public componentWillUnmount() {
		this.unsubscribe();
		ipcRenderer.removeListener('select-image', this.onSelectImage);
	}

	private async onSelectImage(_event: IpcRendererEvent, imagePath: string) {
		await this.selectSource(
			imagePath,
			isURL(imagePath) ? sourceDestination.Http : sourceDestination.File,
		);
	}

	private async createSource(
		selected: string | scanner.adapters.DrivelistDrive,
		SourceType: Source,
	) {
		if (typeof selected === 'string') {
			try {
				selected = await replaceWindowsNetworkDriveLetter(selected);
			} catch (error) {
				analytics.logException(error);
			}

			if (SourceType === sourceDestination.File) {
				return new sourceDestination.File({
					path: selected,
				});
			}
			return new sourceDestination.Http({ url: selected });
		} else {
			return new sourceDestination.BlockDevice({
				drive: selected,
				write: false,
			});
		}
	}

	private reselectSource() {
		analytics.logEvent('Reselect image', {
			previousImage: selectionState.getImage(),
		});

		selectionState.deselectImage();
	}

	private async selectSource(
		selected: string | scanner.adapters.DrivelistDrive,
		SourceType: Source,
	) {
		const sourcePath =
			typeof selected === 'string' ? selected : selected.device;
		const source = await this.createSource(selected, SourceType);
		try {
			let metadata;
			if (typeof selected === 'string') {
				const innerSource = await source.getInnerSource();
				metadata = await this.getMetadata(innerSource);
				if (SourceType === sourceDestination.Http && !isURL(selected)) {
					this.handleError(
						'Unsupported protocol',
						selected,
						messages.error.unsupportedProtocol(),
					);
					return;
				}
				if (supportedFormats.looksLikeWindowsImage(selected)) {
					analytics.logEvent('Possibly Windows image', { image: selected });
					this.setState({
						warning: {
							message: messages.warning.looksLikeWindowsImage(),
							title: 'Possible Windows image detected',
						},
					});
				}
				metadata.extension = path.extname(selected).slice(1);
			} else {
				metadata = await this.getMetadata(source);
				metadata.drive = selected;
			}
			metadata.path = sourcePath;

			if (!metadata.hasMBR) {
				analytics.logEvent('Missing partition table', { metadata });
				this.setState({
					warning: {
						message: messages.warning.missingPartitionTable(),
						title: 'Missing partition table',
					},
				});
			}

			selectionState.selectSource(metadata);
			analytics.logEvent('Select image', {
				// An easy way so we can quickly identify if we're making use of
				// certain features without printing pages of text to DevTools.
				image: {
					...metadata,
					logo: Boolean(metadata.logo),
					blockMap: Boolean(metadata.blockMap),
				},
			});

			this.props.afterSelected({
				sourcePath,
				SourceType,
			});
		} catch (error) {
			this.handleError(
				'Error opening source',
				sourcePath,
				messages.error.openSource(sourcePath, error.message),
				error,
			);
		} finally {
			try {
				await source.close();
			} catch (error) {
				// Noop
			}
		}
	}

	private handleError(
		title: string,
		sourcePath: string,
		description: string,
		error?: any,
	) {
		const imageError = errors.createUserError({
			title,
			description,
		});
		osDialog.showError(imageError);
		if (error) {
			analytics.logException(error);
			return;
		}
		analytics.logEvent(title, { path: sourcePath });
	}

	private async getMetadata(
		source: sourceDestination.SourceDestination | sourceDestination.BlockDevice,
	) {
		let metadata = (await source.getMetadata()) as SourceMetadata;
		const partitionTable = await source.getPartitionTable();
		if (partitionTable) {
			metadata.hasMBR = true;
			metadata.partitions = partitionTable.partitions;
		} else {
			metadata.hasMBR = false;
		}
		return metadata;
	}

	private async openImageSelector() {
		analytics.logEvent('Open image selector');

		try {
			const imagePath = await osDialog.selectImage();
			// Avoid analytics and selection state changes
			// if no file was resolved from the dialog.
			if (!imagePath) {
				analytics.logEvent('Image selector closed');
				return;
			}
			this.selectSource(imagePath, sourceDestination.File);
		} catch (error) {
			exceptionReporter.report(error);
		}
	}

	private onDrop(event: React.DragEvent<HTMLDivElement>) {
		const [file] = event.dataTransfer.files;
		if (file) {
			this.selectSource(file.path, sourceDestination.File);
		}
	}

	private openURLSelector() {
		analytics.logEvent('Open image URL selector');

		this.setState({
			showURLSelector: true,
		});
	}

	private openDriveSelector() {
		analytics.logEvent('Open drive selector');

		this.setState({
			showDriveSelector: true,
		});
	}

	private onDragOver(event: React.DragEvent<HTMLDivElement>) {
		// Needed to get onDrop events on div elements
		event.preventDefault();
	}

	private onDragEnter(event: React.DragEvent<HTMLDivElement>) {
		// Needed to get onDrop events on div elements
		event.preventDefault();
	}

	private showSelectedImageDetails() {
		analytics.logEvent('Show selected image tooltip', {
			imagePath: selectionState.getImagePath(),
		});

		this.setState({
			showImageDetails: true,
		});
	}

	// TODO add a visual change when dragging a file over the selector
	public render() {
		const { flashing } = this.props;
		const { showImageDetails, showURLSelector, showDriveSelector } = this.state;

		const hasSource = selectionState.hasImage();
		let image = hasSource ? selectionState.getImage() : {};

		image = image.drive ? image.drive : image;

		image.name = image.description || image.name;
		const imagePath = image.path || '';
		const imageBasename = path.basename(image.path || '');
		const imageName = image.name || '';
		const imageSize = image.size || '';
		const imageLogo = image.logo || '';

		return (
			<>
				<Flex
					flexDirection="column"
					alignItems="center"
					onDrop={(evt: React.DragEvent<HTMLDivElement>) => this.onDrop(evt)}
					onDragEnter={(evt: React.DragEvent<HTMLDivElement>) =>
						this.onDragEnter(evt)
					}
					onDragOver={(evt: React.DragEvent<HTMLDivElement>) =>
						this.onDragOver(evt)
					}
				>
					<SVGIcon
						contents={imageLogo}
						fallback={ImageSvg}
						style={{
							marginBottom: 30,
						}}
					/>

					{hasSource ? (
						<>
							<StepNameButton
								plain
								onClick={() => this.showSelectedImageDetails()}
								tooltip={imageName || imageBasename}
							>
								{middleEllipsis(imageName || imageBasename, 20)}
							</StepNameButton>
							{!flashing && (
								<ChangeButton
									plain
									mb={14}
									onClick={() => this.reselectSource()}
								>
									Remove
								</ChangeButton>
							)}
							<DetailsText>{shared.bytesToClosestUnit(imageSize)}</DetailsText>
						</>
					) : (
						<>
							<FlowSelector
								key="Flash from file"
								flow={{
									onClick: () => this.openImageSelector(),
									label: 'Flash from file',
									icon: <FontAwesomeIcon icon={faFile} />,
								}}
							/>
							<FlowSelector
								key="Flash from URL"
								flow={{
									onClick: () => this.openURLSelector(),
									label: 'Flash from URL',
									icon: <FontAwesomeIcon icon={faLink} />,
								}}
							/>
							<FlowSelector
								key="Clone drive"
								flow={{
									onClick: () => this.openDriveSelector(),
									label: 'Clone drive',
									icon: <FontAwesomeIcon icon={faCopy} />,
								}}
							/>
						</>
					)}
				</Flex>

				{this.state.warning != null && (
					<SmallModal
						titleElement={
							<span>
								<FontAwesomeIcon
									style={{ color: '#fca321' }}
									icon={faExclamationTriangle}
								/>{' '}
								<span>{this.state.warning.title}</span>
							</span>
						}
						action="Continue"
						cancel={() => {
							this.setState({ warning: null });
							this.reselectSource();
						}}
						done={() => {
							this.setState({ warning: null });
						}}
						primaryButtonProps={{ warning: true, primary: false }}
					>
						<ModalText
							dangerouslySetInnerHTML={{ __html: this.state.warning.message }}
						/>
					</SmallModal>
				)}

				{showImageDetails && (
					<SmallModal
						title="Image"
						done={() => {
							this.setState({ showImageDetails: false });
						}}
					>
						<Txt.p>
							<Txt.span bold>Name: </Txt.span>
							<Txt.span>{imageName || imageBasename}</Txt.span>
						</Txt.p>
						<Txt.p>
							<Txt.span bold>Path: </Txt.span>
							<Txt.span>{imagePath}</Txt.span>
						</Txt.p>
					</SmallModal>
				)}

				{showURLSelector && (
					<URLSelector
						cancel={() => {
							this.setState({
								showURLSelector: false,
							});
						}}
						done={async (imageURL: string) => {
							// Avoid analytics and selection state changes
							// if no file was resolved from the dialog.
							if (!imageURL) {
								analytics.logEvent('URL selector closed');
								this.setState({
									showURLSelector: false,
								});
								return;
							}

							await this.selectSource(imageURL, sourceDestination.Http);
							this.setState({
								showURLSelector: false,
							});
						}}
					/>
				)}

				{showDriveSelector && (
					<DriveSelector
						multipleSelection={false}
						titleLabel="Select source"
						emptyListLabel="Plug a source"
						cancel={() => {
							this.setState({
								showDriveSelector: false,
							});
						}}
						done={async (drives: scanner.adapters.DrivelistDrive[]) => {
							if (!drives.length) {
								analytics.logEvent('Drive selector closed');
								this.setState({
									showDriveSelector: false,
								});
								return;
							}
							await this.selectSource(drives[0], sourceDestination.BlockDevice);
							this.setState({
								showDriveSelector: false,
							});
						}}
					/>
				)}
			</>
		);
	}
}
