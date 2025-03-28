import React, { PureComponent } from 'react';
import PropTypes from 'prop-types';
import { sortBy } from 'lodash';
import Button from '../../ui/button';
import RecipientGroup from './recipient-group/recipient-group.component';

export default class ContactList extends PureComponent {
  static propTypes = {
    qtumAddressBook: PropTypes.object,
    isQtumAddressShowCheck: PropTypes.bool,
    searchForContacts: PropTypes.func,
    searchForRecents: PropTypes.func,
    searchForMyAccounts: PropTypes.func,
    selectRecipient: PropTypes.func,
    children: PropTypes.node,
    selectedAddress: PropTypes.string,
  };

  static contextTypes = {
    t: PropTypes.func,
  };

  state = {
    isShowingAllRecent: false,
  };

  renderRecents() {
    const { t } = this.context;
    const { isShowingAllRecent } = this.state;
    const nonContacts = this.props.searchForRecents();
    const { qtumAddressBook, isQtumAddressShowCheck } = this.props;

    const showLoadMore = !isShowingAllRecent && nonContacts.length > 2;

    return (
      <div className="send__select-recipient-wrapper__recent-group-wrapper">
        <RecipientGroup
          label={t('recents')}
          qtumAddressBook={qtumAddressBook}
          isQtumAddressShowCheck={isQtumAddressShowCheck}
          items={showLoadMore ? nonContacts.slice(0, 2) : nonContacts}
          onSelect={this.props.selectRecipient}
          selectedAddress={this.props.selectedAddress}
        />
        {showLoadMore && (
          <Button
            type="link"
            className="send__select-recipient-wrapper__recent-group-wrapper__load-more"
            onClick={() => this.setState({ isShowingAllRecent: true })}
          >
            {t('loadMore')}
          </Button>
        )}
      </div>
    );
  }

  renderAddressBook() {
    const { qtumAddressBook, isQtumAddressShowCheck } = this.props;
    const unsortedContactsByLetter = this.props
      .searchForContacts()
      .reduce((obj, contact) => {
        const firstLetter = contact.name[0].toUpperCase();
        return {
          ...obj,
          [firstLetter]: [...(obj[firstLetter] || []), contact],
        };
      }, {});

    const letters = Object.keys(unsortedContactsByLetter).sort();

    const sortedContactGroups = letters.map((letter) => {
      return [
        letter,
        sortBy(unsortedContactsByLetter[letter], (contact) => {
          return contact.name.toLowerCase();
        }),
      ];
    });

    return sortedContactGroups.map(([letter, groupItems]) => (
      <RecipientGroup
        key={`${letter}-contact-group`}
        label={letter}
        items={groupItems}
        qtumAddressBook={qtumAddressBook}
        isQtumAddressShowCheck={isQtumAddressShowCheck}
        onSelect={this.props.selectRecipient}
        selectedAddress={this.props.selectedAddress}
      />
    ));
  }

  renderMyAccounts() {
    const myAccounts = this.props.searchForMyAccounts();
    const { qtumAddressBook, isQtumAddressShowCheck } = this.props;

    return (
      <RecipientGroup
        items={myAccounts}
        qtumAddressBook={qtumAddressBook}
        isQtumAddressShowCheck={isQtumAddressShowCheck}
        onSelect={this.props.selectRecipient}
        selectedAddress={this.props.selectedAddress}
      />
    );
  }

  render() {
    const {
      children,
      searchForRecents,
      searchForContacts,
      searchForMyAccounts,
    } = this.props;

    return (
      <div className="send__select-recipient-wrapper__list">
        {children || null}
        {searchForRecents ? this.renderRecents() : null}
        {searchForContacts ? this.renderAddressBook() : null}
        {searchForMyAccounts ? this.renderMyAccounts() : null}
      </div>
    );
  }
}
